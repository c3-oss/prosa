// Raw source pack: preserves the verbatim bytes of source files. Same
// framing as CAS packs but with per-entry source-file locator metadata.
//
// Magic: `PROSA_RAW_SRC_V2`.

import { blake3 } from '@noble/hashes/blake3'

import {
  type RawSourceLeafInput,
  type RawSourcePackEntryV2,
  type SourceTool,
  rawSourceRootFromEntries,
  toHex,
} from '@c3-oss/prosa-types-v2'

import { type PackFraming, canonicalJson, decodePackFrame, encodePackFrame } from './framing.js'
import { ZSTD_MAX_WINDOW_LOG, zstdCompress, zstdDecompress } from './zstd.js'

export const RAW_SRC_PACK_MAGIC = 'PROSA_RAW_SRC_V2'
export const RAW_SRC_PACK_VERSION = 2

export type RawSourcePackHeaderV2 = {
  pack_digest: string
  created_at: string
  compression_default: 'zstd' | 'none'
  zstd_window_log: number
  entry_count: number
  /** Merkle root over the entries, computed via canonical helpers. */
  raw_source_root: string
  entries: RawSourcePackEntryV2[]
}

export type RawSourcePackInput = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  file_kind: string
  mtime_ns: number | null
  bytes: Uint8Array
  compression?: 'zstd' | 'none'
  workspace_hint?: string | null
}

export type RawSourcePackBuildOptions = {
  createdAt: string
  compressionDefault?: 'zstd' | 'none'
  zstdWindowLog?: number
}

export type RawSourcePackBuilt = {
  bytes: Uint8Array
  header: RawSourcePackHeaderV2
  packDigest: string
}

export class RawSourcePackVerifyError extends Error {
  override name = 'RawSourcePackVerifyError'
}

export function buildRawSourcePack(
  inputs: readonly RawSourcePackInput[],
  options: RawSourcePackBuildOptions,
): RawSourcePackBuilt {
  const compressionDefault = options.compressionDefault ?? 'zstd'
  const zstdWindowLog = options.zstdWindowLog ?? 21
  if (zstdWindowLog > ZSTD_MAX_WINDOW_LOG) {
    throw new Error(`buildRawSourcePack: zstdWindowLog ${zstdWindowLog} exceeds canonical max ${ZSTD_MAX_WINDOW_LOG}`)
  }

  // Entries are sorted by `source_file_id` ASC so that:
  //   1. The raw_source_root in the header matches the canonical
  //      rawSourceRoot computation in prosa-types-v2 (which sorts by
  //      source_file_id ASC).
  //   2. Random recovery by source_file_id can binary-search the entries.
  const sorted = [...inputs].sort((a, b) => compareBytewise(a.source_file_id, b.source_file_id))

  const payloadParts: Uint8Array[] = []
  const entries: RawSourcePackEntryV2[] = []
  const leafInputs: RawSourceLeafInput[] = []
  let offset = 0
  for (const input of sorted) {
    const compression = input.compression ?? compressionDefault
    const uncompressedHashHex = toHex(blake3(input.bytes))
    const stored = compression === 'zstd' ? zstdCompress(input.bytes, { windowLog: zstdWindowLog }) : input.bytes
    const storedHashHex = toHex(blake3(stored))
    const entry: RawSourcePackEntryV2 = {
      source_file_id: input.source_file_id,
      source_tool: input.source_tool,
      path: input.path,
      file_kind: input.file_kind,
      size_bytes: input.bytes.length,
      mtime_ns: input.mtime_ns,
      content_hash: `blake3:${uncompressedHashHex}`,
      object_id: `blake3:${uncompressedHashHex}`,
      stored_offset: offset,
      stored_length: stored.length,
      compression,
      uncompressed_hash: `blake3:${uncompressedHashHex}`,
      uncompressed_size: input.bytes.length,
      stored_hash: `blake3:${storedHashHex}`,
      ...(input.workspace_hint !== undefined ? { workspace_hint: input.workspace_hint } : {}),
    }
    entries.push(entry)
    leafInputs.push({
      source_file_id: entry.source_file_id,
      content_hash: entry.content_hash,
      uncompressed_size: entry.uncompressed_size,
      compression: entry.compression,
      stored_hash: entry.stored_hash,
    })
    payloadParts.push(stored)
    offset += stored.length
  }

  const payloadLen = payloadParts.reduce((n, p) => n + p.length, 0)
  const payload = new Uint8Array(payloadLen)
  {
    let cursor = 0
    for (const p of payloadParts) {
      payload.set(p, cursor)
      cursor += p.length
    }
  }

  const rawSourceRoot = toHex(rawSourceRootFromEntries(leafInputs))

  const headerNoDigest: Omit<RawSourcePackHeaderV2, 'pack_digest'> = {
    created_at: options.createdAt,
    compression_default: compressionDefault,
    zstd_window_log: zstdWindowLog,
    entry_count: entries.length,
    raw_source_root: rawSourceRoot,
    entries,
  }
  const placeholderHeader: RawSourcePackHeaderV2 = {
    pack_digest: `blake3:${'0'.repeat(64)}`,
    ...headerNoDigest,
  }
  const placeholderBytes = canonicalJson(placeholderHeader)
  const placeholderFrame = encodePackFrame({
    magic: RAW_SRC_PACK_MAGIC,
    version: RAW_SRC_PACK_VERSION,
    headerBytes: placeholderBytes,
    payload,
  })
  const packDigestHex = toHex(blake3(placeholderFrame))
  const header: RawSourcePackHeaderV2 = {
    pack_digest: `blake3:${packDigestHex}`,
    ...headerNoDigest,
  }
  const headerBytes = canonicalJson(header)
  if (headerBytes.length !== placeholderBytes.length) {
    throw new Error('buildRawSourcePack: header length changed after pack_digest substitution')
  }
  const bytes = encodePackFrame({
    magic: RAW_SRC_PACK_MAGIC,
    version: RAW_SRC_PACK_VERSION,
    headerBytes,
    payload,
  })
  return { bytes, header, packDigest: header.pack_digest }
}

export type RawSourcePackVerifyResult = {
  header: RawSourcePackHeaderV2
  entries: Array<{ entry: RawSourcePackEntryV2; uncompressed: Uint8Array }>
}

export function verifyRawSourcePack(bytes: Uint8Array): RawSourcePackVerifyResult {
  const frame: PackFraming = decodePackFrame(bytes)
  if (frame.magic !== RAW_SRC_PACK_MAGIC) {
    throw new RawSourcePackVerifyError(`magic mismatch (expected ${RAW_SRC_PACK_MAGIC}, got ${frame.magic})`)
  }
  if (frame.version !== RAW_SRC_PACK_VERSION) {
    throw new RawSourcePackVerifyError(`version mismatch (expected ${RAW_SRC_PACK_VERSION}, got ${frame.version})`)
  }
  const header = JSON.parse(new TextDecoder().decode(frame.headerBytes)) as RawSourcePackHeaderV2
  if (header.zstd_window_log > ZSTD_MAX_WINDOW_LOG) {
    throw new RawSourcePackVerifyError(`PACK_ZSTD_WINDOW_TOO_LARGE: zstd_window_log ${header.zstd_window_log}`)
  }
  if (header.entry_count !== header.entries.length) {
    throw new RawSourcePackVerifyError(`entry_count ${header.entry_count} != entries.length ${header.entries.length}`)
  }
  // Confirm entries are sorted by source_file_id ASC (canonical pin).
  for (let i = 1; i < header.entries.length; i++) {
    const prev = header.entries[i - 1] as RawSourcePackEntryV2
    const curr = header.entries[i] as RawSourcePackEntryV2
    if (compareBytewise(prev.source_file_id, curr.source_file_id) >= 0) {
      throw new RawSourcePackVerifyError(
        `entries not sorted by source_file_id ASC at index ${i}: ${prev.source_file_id} >= ${curr.source_file_id}`,
      )
    }
  }
  const out: RawSourcePackVerifyResult = { header, entries: [] }
  const leafInputs: RawSourceLeafInput[] = []
  for (const entry of header.entries) {
    const slice = frame.payload.slice(entry.stored_offset, entry.stored_offset + entry.stored_length)
    if (slice.length !== entry.stored_length) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: stored_length out of range`)
    }
    const storedHash = `blake3:${toHex(blake3(slice))}`
    if (storedHash !== entry.stored_hash) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: stored_hash mismatch`)
    }
    const uncompressed = entry.compression === 'zstd' ? zstdDecompress(slice) : slice
    const uncompressedHash = `blake3:${toHex(blake3(uncompressed))}`
    if (uncompressed.length !== entry.uncompressed_size) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: uncompressed_size mismatch`)
    }
    if (uncompressedHash !== entry.uncompressed_hash) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: uncompressed_hash mismatch`)
    }
    if (uncompressedHash !== entry.content_hash) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: content_hash != uncompressed_hash`)
    }
    if (uncompressedHash !== entry.object_id) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: object_id != uncompressed_hash`)
    }
    if (uncompressed.length !== entry.size_bytes) {
      throw new RawSourcePackVerifyError(`entry ${entry.source_file_id}: size_bytes != uncompressed.length`)
    }
    leafInputs.push({
      source_file_id: entry.source_file_id,
      content_hash: entry.content_hash,
      uncompressed_size: entry.uncompressed_size,
      compression: entry.compression,
      stored_hash: entry.stored_hash,
    })
    out.entries.push({ entry, uncompressed })
  }
  // Verify the header's raw_source_root matches the canonical recomputation.
  const recomputed = toHex(rawSourceRootFromEntries(leafInputs))
  if (recomputed !== header.raw_source_root) {
    throw new RawSourcePackVerifyError(
      `raw_source_root mismatch (header=${header.raw_source_root} recomputed=${recomputed})`,
    )
  }
  return out
}

/**
 * O(1)-ish random recovery of a source file by source_file_id. Returns the
 * verified entry and its decompressed bytes.
 */
export function recoverSourceFile(
  bytes: Uint8Array,
  sourceFileId: string,
): { entry: RawSourcePackEntryV2; uncompressed: Uint8Array } {
  const { entries } = verifyRawSourcePack(bytes)
  const hit = entries.find((e) => e.entry.source_file_id === sourceFileId)
  if (!hit) {
    throw new RawSourcePackVerifyError(`source_file_id ${sourceFileId} not found in pack`)
  }
  return hit
}

function compareBytewise(a: string, b: string): number {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  const len = Math.min(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    const av = ab[i] as number
    const bv = bb[i] as number
    if (av !== bv) return av - bv
  }
  return ab.length - bb.length
}
