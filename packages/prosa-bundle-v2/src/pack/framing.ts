// Shared binary framing for CAS and raw-source packs.
//
// Layout (32-byte fixed prefix + header + payload):
//
//   0       16 bytes   magic (ASCII, NUL-padded if shorter)
//   16      u16le      version
//   18      u16le      flags
//   20      u32le      header_len
//   24      32 bytes   header_blake3 (over header CBOR bytes)
//   56      header_len bytes   canonical-JSON header  (CBOR support is reserved for later;
//                              JSON keeps Lane 1 self-contained without a CBOR decoder
//                              for nested objects)
//   56 + header_len   N bytes   payload
//
// Why JSON not CBOR for the header: prosa-types-v2 only exposes a
// canonical-CBOR encoder for primitive/array tuples (the Merkle leaf path).
// The pack header has nested objects and arrays of records; rather than
// re-implement object CBOR here, we keep the header as canonical JSON
// (RFC 8785 JCS-style stable ordering) and hash that. The pack bytes
// remain self-contained and verifiable.

import { blake3 } from '@noble/hashes/blake3'

import { toHex } from '@c3-oss/prosa-types-v2'

export const MAGIC_LEN = 16
export const FIXED_PREFIX_LEN = 56 // magic + version + flags + header_len + header_blake3

export type PackFraming = {
  magic: string
  version: number
  flags: number
  headerBytes: Uint8Array
  headerHash: Uint8Array
  payload: Uint8Array
}

export function encodePackFrame(args: {
  magic: string
  version: number
  flags?: number
  headerBytes: Uint8Array
  payload: Uint8Array
}): Uint8Array {
  if (args.magic.length === 0 || args.magic.length > MAGIC_LEN) {
    throw new Error(`encodePackFrame: magic must be 1..${MAGIC_LEN} bytes`)
  }
  if (args.version > 0xffff || args.version < 0) {
    throw new Error('encodePackFrame: version must fit in u16')
  }
  const flags = args.flags ?? 0
  if (flags > 0xffff || flags < 0) throw new Error('encodePackFrame: flags must fit in u16')

  const magicBytes = new Uint8Array(MAGIC_LEN)
  new TextEncoder().encodeInto(args.magic, magicBytes)

  const headerHash = blake3(args.headerBytes)
  const total = FIXED_PREFIX_LEN + args.headerBytes.length + args.payload.length
  const out = new Uint8Array(total)
  out.set(magicBytes, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint16(MAGIC_LEN, args.version, true)
  view.setUint16(MAGIC_LEN + 2, flags, true)
  view.setUint32(MAGIC_LEN + 4, args.headerBytes.length, true)
  out.set(headerHash, MAGIC_LEN + 8)
  out.set(args.headerBytes, FIXED_PREFIX_LEN)
  out.set(args.payload, FIXED_PREFIX_LEN + args.headerBytes.length)
  return out
}

export function decodePackFrame(buf: Uint8Array): PackFraming {
  if (buf.length < FIXED_PREFIX_LEN) {
    throw new Error(`decodePackFrame: buffer too short (${buf.length} < ${FIXED_PREFIX_LEN})`)
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magicBytes = buf.slice(0, MAGIC_LEN)
  // Trim trailing NUL bytes.
  let magicEnd = MAGIC_LEN
  while (magicEnd > 0 && magicBytes[magicEnd - 1] === 0) magicEnd--
  const magic = new TextDecoder('utf-8').decode(magicBytes.slice(0, magicEnd))
  const version = view.getUint16(MAGIC_LEN, true)
  const flags = view.getUint16(MAGIC_LEN + 2, true)
  const headerLen = view.getUint32(MAGIC_LEN + 4, true)
  const headerHash = buf.slice(MAGIC_LEN + 8, MAGIC_LEN + 8 + 32)
  if (buf.length < FIXED_PREFIX_LEN + headerLen) {
    throw new Error(`decodePackFrame: header_len ${headerLen} exceeds buffer`)
  }
  const headerBytes = buf.slice(FIXED_PREFIX_LEN, FIXED_PREFIX_LEN + headerLen)
  const computedHash = blake3(headerBytes)
  if (!equalBytes(headerHash, computedHash)) {
    throw new Error(
      `decodePackFrame: header_blake3 mismatch (stored=${toHex(headerHash)} computed=${toHex(computedHash)})`,
    )
  }
  const payload = buf.slice(FIXED_PREFIX_LEN + headerLen)
  return { magic, version, flags, headerBytes, headerHash, payload }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Canonical JSON for pack headers.
// ---------------------------------------------------------------------------

/**
 * Serialize a value as canonical JSON: keys sorted ASC, no whitespace,
 * standard JSON.stringify primitives. This is RFC 8785 (JCS)-style minus
 * the number normalization; pack headers only use integer counts and
 * lowercase hex/tagged-hash strings, no floats.
 */
export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonString(value))
}

export function canonicalJsonString(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    if (!Number.isInteger(value)) throw new Error('canonicalJson: non-integer number')
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return JSON.stringify(sanitizeJsonString(value))
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonString(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(sanitizeJsonString(k))}:${canonicalJsonString(obj[k])}`).join(',')}}`
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
}

/**
 * Replace unpaired UTF-16 surrogate code units with U+FFFD (REPLACEMENT
 * CHARACTER). `JSON.stringify` happily emits lone surrogates verbatim
 * (e.g. `"\uD83D"` without its low half), but the resulting JSON is not
 * valid UTF-8 and is rejected by RFC 8259-conformant parsers — DuckDB's
 * `read_json_auto` in particular fails the projection→Parquet path with
 * "no low surrogate in string". The substitution is idempotent: a
 * sanitized string is a fixed point, so re-hashing stays deterministic.
 * Valid surrogate pairs (e.g. emoji) survive intact.
 */
export function sanitizeJsonString(s: string): string {
  let out: string | null = null
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — must be followed by a low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (out !== null) out += String.fromCharCode(code, next)
        i++
        continue
      }
      if (out === null) out = s.slice(0, i)
      out += '�'
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate not preceded by a high surrogate.
      if (out === null) out = s.slice(0, i)
      out += '�'
      continue
    }
    if (out !== null) out += String.fromCharCode(code)
  }
  return out === null ? s : out
}
