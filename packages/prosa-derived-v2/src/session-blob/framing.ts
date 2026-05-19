// SessionBlobPackV2 binary framing.
//
// Mirrors the shared 56-byte fixed prefix used by `prosa-bundle-v2` pack
// formats, with a session-blob-specific `magic` so readers can dispatch
// on the leading bytes without parsing the header.
//
// CQ-084: the magic must fit in the 16-byte fixed-prefix slot. Earlier
// drafts used "prosa-session-blob" (18 bytes), which `encodeInto`
// silently truncates to 16 bytes while the decoder still compared
// against the 18-byte string, so the format failed to round-trip its
// own output. The chosen 16-byte magic `PROSA_SESS_PACK2` mirrors the
// bundle-v2 convention (`PROSA_CAS_PACK_2`, `PROSA_RAW_SRC_V2`).
//
//   0       16 bytes   magic "PROSA_SESS_PACK2" (NUL-padded)
//   16      u16le      version
//   18      u16le      flags
//   20      u32le      header_len
//   24      32 bytes   header_blake3 (over header bytes)
//   56      header_len bytes   canonical-JSON header (SessionBlobPackHeaderV2)
//   56 + header_len      payload bytes  (concatenation of zstd-compressed page bodies)
//
// The header is canonical JSON (RFC 8785-style stable ordering) for the
// same reason `prosa-bundle-v2` uses canonical JSON for its pack headers:
// `prosa-types-v2` only exposes a CBOR encoder for primitive tuples
// (Merkle leaves), and Lane 3 deliberately stays self-contained without
// pulling a new CBOR dependency.

import { toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

export const SESSION_BLOB_MAGIC = 'PROSA_SESS_PACK2'
export const SESSION_BLOB_VERSION = 1
const MAGIC_LEN = 16
const FIXED_PREFIX_LEN = 56

export interface SessionBlobFraming {
  magic: string
  version: number
  flags: number
  headerBytes: Uint8Array
  headerHash: Uint8Array
  payload: Uint8Array
}

export function encodeSessionBlobFrame(args: {
  headerBytes: Uint8Array
  payload: Uint8Array
  flags?: number
}): Uint8Array {
  if (args.headerBytes.length > 0xffffffff) {
    throw new Error('encodeSessionBlobFrame: header too large for u32 length prefix')
  }
  const flags = args.flags ?? 0
  if (flags < 0 || flags > 0xffff) {
    throw new Error('encodeSessionBlobFrame: flags must fit in u16')
  }
  const magicBytes = new Uint8Array(MAGIC_LEN)
  new TextEncoder().encodeInto(SESSION_BLOB_MAGIC, magicBytes)
  const headerHash = blake3(args.headerBytes)
  const out = new Uint8Array(FIXED_PREFIX_LEN + args.headerBytes.length + args.payload.length)
  out.set(magicBytes, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint16(MAGIC_LEN, SESSION_BLOB_VERSION, true)
  view.setUint16(MAGIC_LEN + 2, flags, true)
  view.setUint32(MAGIC_LEN + 4, args.headerBytes.length, true)
  out.set(headerHash, MAGIC_LEN + 8)
  out.set(args.headerBytes, FIXED_PREFIX_LEN)
  out.set(args.payload, FIXED_PREFIX_LEN + args.headerBytes.length)
  return out
}

export function decodeSessionBlobFrame(buf: Uint8Array): SessionBlobFraming {
  if (buf.length < FIXED_PREFIX_LEN) {
    throw new Error(`decodeSessionBlobFrame: buffer too short (${buf.length} < ${FIXED_PREFIX_LEN})`)
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magicBytes = buf.slice(0, MAGIC_LEN)
  let magicEnd = MAGIC_LEN
  while (magicEnd > 0 && magicBytes[magicEnd - 1] === 0) magicEnd--
  const magic = new TextDecoder('utf-8').decode(magicBytes.slice(0, magicEnd))
  if (magic !== SESSION_BLOB_MAGIC) {
    throw new Error(`decodeSessionBlobFrame: magic mismatch (got "${magic}")`)
  }
  const version = view.getUint16(MAGIC_LEN, true)
  if (version !== SESSION_BLOB_VERSION) {
    throw new Error(`decodeSessionBlobFrame: unsupported version ${version}`)
  }
  const flags = view.getUint16(MAGIC_LEN + 2, true)
  const headerLen = view.getUint32(MAGIC_LEN + 4, true)
  const headerHash = buf.slice(MAGIC_LEN + 8, MAGIC_LEN + 8 + 32)
  if (buf.length < FIXED_PREFIX_LEN + headerLen) {
    throw new Error(`decodeSessionBlobFrame: header_len ${headerLen} exceeds buffer`)
  }
  const headerBytes = buf.slice(FIXED_PREFIX_LEN, FIXED_PREFIX_LEN + headerLen)
  const computedHash = blake3(headerBytes)
  if (!equalBytes(headerHash, computedHash)) {
    throw new Error(
      `decodeSessionBlobFrame: header_blake3 mismatch (stored=${toHex(headerHash)} computed=${toHex(computedHash)})`,
    )
  }
  const payload = buf.slice(FIXED_PREFIX_LEN + headerLen)
  return { magic, version, flags, headerBytes, headerHash, payload }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Canonical-JSON encode an object with sorted keys (recursive). Mirrors
 * the RFC 8785-style stable ordering used by the bundle-v2 manifests
 * and pack headers so the header bytes are deterministic and
 * verifiable.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  throw new Error(`canonicalJsonBytes: unsupported value of type ${typeof value}`)
}
