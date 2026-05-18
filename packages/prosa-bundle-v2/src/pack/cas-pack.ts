// CAS object pack: a single file containing one or more content-addressed
// objects, each compressed independently with zstd (windowLog <= 23).
//
// Magic: 16 bytes, NUL-padded. The lane doc shows "PROSA_CAS_PACK_V2"
// (17 chars), which doesn't fit a 16-byte field; we drop the `V` to keep
// both the field width and the v2 generation marker.
// Header is canonical JSON of `CasPackHeaderV2`.

import { blake3 } from '@noble/hashes/blake3'

import { toHex } from '@c3-oss/prosa-types-v2'

import { type PackFraming, canonicalJson, decodePackFrame, encodePackFrame } from './framing.js'
import { ZSTD_MAX_WINDOW_LOG, zstdCompress, zstdDecompress } from './zstd.js'

export const CAS_PACK_MAGIC = 'PROSA_CAS_PACK_2'
export const CAS_PACK_VERSION = 2

export type CasPackEntryV2 = {
  object_id: string // 'blake3:<hex>'
  uncompressed_hash: string // synonym of object_id
  uncompressed_size: number
  stored_offset: number
  stored_length: number
  stored_hash: string // 'blake3:<hex>' over the stored bytes slice
  compression: 'zstd' | 'none'
  mime_type?: string
  encoding?: string
}

export type CasPackHeaderV2 = {
  pack_digest: string // 'blake3:<hex>' over the entire encoded pack (header bytes + payload)
  created_at: string
  compression_default: 'zstd' | 'none'
  zstd_window_log: number
  entry_count: number
  entries: CasPackEntryV2[]
  standalone_large_object: boolean
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const PACK_DIGEST_PLACEHOLDER = `blake3:${'0'.repeat(64)}`

function verifyCasPackDigest(header: CasPackHeaderV2, payload: Uint8Array): void {
  const declared = header.pack_digest
  if (!/^blake3:[0-9a-f]{64}$/u.test(declared)) {
    throw new CasPackVerifyError(`pack_digest ${declared} not in canonical 'blake3:<64-hex>' form`)
  }
  const placeholderHeader: CasPackHeaderV2 = { ...header, pack_digest: PACK_DIGEST_PLACEHOLDER }
  const placeholderBytes = canonicalJson(placeholderHeader)
  const placeholderFrame = encodePackFrame({
    magic: CAS_PACK_MAGIC,
    version: CAS_PACK_VERSION,
    headerBytes: placeholderBytes,
    payload,
  })
  const recomputed = `blake3:${toHex(blake3(placeholderFrame))}`
  if (recomputed !== declared) {
    throw new CasPackVerifyError(`pack_digest mismatch: declared ${declared}, recomputed ${recomputed}`)
  }
}

export type CasPackInput = {
  /** Raw object bytes (uncompressed). The pack assigns offsets. */
  bytes: Uint8Array
  compression?: 'zstd' | 'none'
  mime_type?: string
  encoding?: string
}

export type CasPackBuildOptions = {
  /** Canonical UTC ms-precision timestamp. */
  createdAt: string
  /** Defaults to 'zstd'. */
  compressionDefault?: 'zstd' | 'none'
  /** Defaults to 21 (2 MiB window). Must be ≤ ZSTD_MAX_WINDOW_LOG. */
  zstdWindowLog?: number
  /** Single-large-object pack marker (≥ 32 MiB). */
  standaloneLargeObject?: boolean
}

export type CasPackBuilt = {
  bytes: Uint8Array
  header: CasPackHeaderV2
  packDigest: string
}

export type CasPackVerifyResult = {
  header: CasPackHeaderV2
  /** Decoded entries with their decompressed bytes attached. */
  entries: Array<{ entry: CasPackEntryV2; uncompressed: Uint8Array }>
}

export class CasPackVerifyError extends Error {
  override name = 'CasPackVerifyError'
}

/**
 * Build a CAS pack from a sequence of object inputs. The pack assigns
 * `stored_offset`/`stored_length` and computes `object_id`,
 * `uncompressed_hash`, and `stored_hash`. The returned bytes are the
 * fully encoded pack ready to be written to disk.
 */
export function buildCasPack(inputs: readonly CasPackInput[], options: CasPackBuildOptions): CasPackBuilt {
  const compressionDefault = options.compressionDefault ?? 'zstd'
  const zstdWindowLog = options.zstdWindowLog ?? 21
  if (zstdWindowLog > ZSTD_MAX_WINDOW_LOG) {
    throw new Error(`buildCasPack: zstdWindowLog ${zstdWindowLog} exceeds canonical max ${ZSTD_MAX_WINDOW_LOG}`)
  }

  const payloadParts: Uint8Array[] = []
  const entries: CasPackEntryV2[] = []
  let offset = 0
  for (const input of inputs) {
    const compression = input.compression ?? compressionDefault
    const uncompressed = input.bytes
    const objectIdHex = toHex(blake3(uncompressed))
    const stored = compression === 'zstd' ? zstdCompress(uncompressed, { windowLog: zstdWindowLog }) : uncompressed
    const storedHashHex = toHex(blake3(stored))
    const entry: CasPackEntryV2 = {
      object_id: `blake3:${objectIdHex}`,
      uncompressed_hash: `blake3:${objectIdHex}`,
      uncompressed_size: uncompressed.length,
      stored_offset: offset,
      stored_length: stored.length,
      stored_hash: `blake3:${storedHashHex}`,
      compression,
    }
    if (input.mime_type) entry.mime_type = input.mime_type
    if (input.encoding) entry.encoding = input.encoding
    entries.push(entry)
    payloadParts.push(stored)
    offset += stored.length
  }

  // Concatenate payload.
  const payloadLen = payloadParts.reduce((n, p) => n + p.length, 0)
  const payload = new Uint8Array(payloadLen)
  {
    let cursor = 0
    for (const p of payloadParts) {
      payload.set(p, cursor)
      cursor += p.length
    }
  }

  // First build the header WITHOUT a pack_digest, encode the pack, compute
  // the digest, then rewrite the header. This is the standard
  // two-pass content-addressed pack construction: the digest covers the
  // header bytes + payload bytes that the final pack carries on disk.
  const headerNoDigest: Omit<CasPackHeaderV2, 'pack_digest'> = {
    created_at: options.createdAt,
    compression_default: compressionDefault,
    zstd_window_log: zstdWindowLog,
    entry_count: entries.length,
    entries,
    standalone_large_object: options.standaloneLargeObject ?? false,
  }
  const placeholderHeader: CasPackHeaderV2 = {
    pack_digest: `blake3:${'0'.repeat(64)}`,
    ...headerNoDigest,
  }
  const placeholderBytes = canonicalJson(placeholderHeader)
  const placeholderFrame = encodePackFrame({
    magic: CAS_PACK_MAGIC,
    version: CAS_PACK_VERSION,
    headerBytes: placeholderBytes,
    payload,
  })
  // Compute pack_digest over the framed bytes EXCLUDING the placeholder
  // digest substring. To keep it simple we hash over (header bytes with
  // pack_digest replaced by the canonical zero hash) + payload — which is
  // what the placeholder frame already represents.
  const packDigestHex = toHex(blake3(placeholderFrame))
  const header: CasPackHeaderV2 = {
    pack_digest: `blake3:${packDigestHex}`,
    ...headerNoDigest,
  }
  // Re-encode with the real digest. The header byte length is identical
  // because pack_digest is the same length in both cases.
  const headerBytes = canonicalJson(header)
  if (headerBytes.length !== placeholderBytes.length) {
    throw new Error('buildCasPack: header length changed after pack_digest substitution')
  }
  const bytes = encodePackFrame({
    magic: CAS_PACK_MAGIC,
    version: CAS_PACK_VERSION,
    headerBytes,
    payload,
  })
  return { bytes, header, packDigest: header.pack_digest }
}

/**
 * Decode and verify a CAS pack. Throws on:
 * - magic / version mismatch,
 * - header BLAKE3 mismatch (caught by the framing layer),
 * - self-referential `pack_digest` mismatch (CQ-026),
 * - entry stored_hash mismatch,
 * - entry uncompressed_hash mismatch,
 * - declared zstd_window_log exceeding the canonical max.
 */
export function verifyCasPack(bytes: Uint8Array): CasPackVerifyResult {
  const frame: PackFraming = decodePackFrame(bytes)
  if (frame.magic !== CAS_PACK_MAGIC) {
    throw new CasPackVerifyError(`magic mismatch (expected ${CAS_PACK_MAGIC}, got ${frame.magic})`)
  }
  if (frame.version !== CAS_PACK_VERSION) {
    throw new CasPackVerifyError(`version mismatch (expected ${CAS_PACK_VERSION}, got ${frame.version})`)
  }
  const header = JSON.parse(new TextDecoder().decode(frame.headerBytes)) as CasPackHeaderV2
  // CQ-035: the header bytes must be the canonical JSON encoding of the
  // parsed header. Otherwise a reordered-key or whitespace-padded header
  // could carry the same logical content as the canonical encoding while
  // differing from the pack's byte identity.
  const canonical = canonicalJson(header)
  if (!bytesEqual(canonical, frame.headerBytes)) {
    throw new CasPackVerifyError('pack header bytes are not canonical JSON')
  }
  if (header.zstd_window_log > ZSTD_MAX_WINDOW_LOG) {
    throw new CasPackVerifyError(
      `PACK_ZSTD_WINDOW_TOO_LARGE: zstd_window_log ${header.zstd_window_log} > ${ZSTD_MAX_WINDOW_LOG}`,
    )
  }
  if (header.entry_count !== header.entries.length) {
    throw new CasPackVerifyError(`entry_count ${header.entry_count} != entries.length ${header.entries.length}`)
  }
  // CQ-026: re-derive the self-referential pack_digest. The build path
  // hashes the framed bytes with the digest field replaced by the
  // placeholder; verify reproduces the same substitution.
  verifyCasPackDigest(header, frame.payload)
  const out: CasPackVerifyResult = { header, entries: [] }
  for (const entry of header.entries) {
    const slice = frame.payload.slice(entry.stored_offset, entry.stored_offset + entry.stored_length)
    if (slice.length !== entry.stored_length) {
      throw new CasPackVerifyError(`entry ${entry.object_id}: stored_length out of range`)
    }
    const storedHash = `blake3:${toHex(blake3(slice))}`
    if (storedHash !== entry.stored_hash) {
      throw new CasPackVerifyError(
        `entry ${entry.object_id}: stored_hash mismatch (expected ${entry.stored_hash}, got ${storedHash})`,
      )
    }
    const uncompressed = entry.compression === 'zstd' ? zstdDecompress(slice) : slice
    if (uncompressed.length !== entry.uncompressed_size) {
      throw new CasPackVerifyError(
        `entry ${entry.object_id}: uncompressed_size mismatch (expected ${entry.uncompressed_size}, got ${uncompressed.length})`,
      )
    }
    const uncompressedHash = `blake3:${toHex(blake3(uncompressed))}`
    if (uncompressedHash !== entry.uncompressed_hash) {
      throw new CasPackVerifyError(
        `entry ${entry.object_id}: uncompressed_hash mismatch (expected ${entry.uncompressed_hash}, got ${uncompressedHash})`,
      )
    }
    if (uncompressedHash !== entry.object_id) {
      throw new CasPackVerifyError(`entry: object_id ${entry.object_id} != uncompressed_hash ${uncompressedHash}`)
    }
    out.entries.push({ entry, uncompressed })
  }
  return out
}
