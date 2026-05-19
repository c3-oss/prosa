// SessionBlobPackV2 reader.
//
// `loadTranscriptPage(pack, cursor)` round-trips the output of
// `writeSessionBlobPack` and validates per-page hashes against the
// header. Each page payload is decompressed via the caller-supplied
// decompressor (the writer is symmetric; tests use an identity
// decompressor when paired with an identity compressor).

import { toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import { canonicalJsonBytes, decodeSessionBlobFrame } from './framing.js'
import type { SessionBlobPackHeaderV2, SessionBlobPageRefV2, TranscriptTextBodyV2 } from './types.js'

export type SessionBlobDecompressor = (compressed: Uint8Array) => Uint8Array

export interface DecodedSessionBlobPack {
  header: SessionBlobPackHeaderV2
  /** Raw bytes of every page payload (compressed). Tests may inspect
   *  these directly; production callers should prefer `loadPage`. */
  pageBytes: Uint8Array[]
}

export interface DecodedPageBody {
  page_index: number
  session_id: string
  message_ordinal_start: number
  message_ordinal_end: number
  messages: Array<{
    message_id: string
    ordinal: number
    role: string
    timestamp: string | null
    turn_id: string | null
    blocks: Array<{
      block_id: string
      block_type: string
      body: TranscriptTextBodyV2
    }>
  }>
}

/**
 * Decode the framed pack into its header plus per-page byte slices.
 * Verifies the header blake3 binding implicitly (the framing layer
 * raises on mismatch).
 */
export function decodeSessionBlobPack(buf: Uint8Array): DecodedSessionBlobPack {
  const framing = decodeSessionBlobFrame(buf)
  const headerJson = new TextDecoder('utf-8').decode(framing.headerBytes)
  const header = JSON.parse(headerJson) as SessionBlobPackHeaderV2
  const pageBytes: Uint8Array[] = []
  for (const page of header.pages) {
    const slice = framing.payload.slice(page.stored_offset, page.stored_offset + page.stored_length)
    if (slice.length !== page.stored_length) {
      throw new Error(
        `decodeSessionBlobPack: page ${page.page_index} stored_length ${page.stored_length} exceeds payload`,
      )
    }
    pageBytes.push(slice)
  }
  return { header, pageBytes }
}

/**
 * Load one page out of the pack by its index, decompress the body,
 * and verify both the stored-bytes hash (compressed) and the
 * uncompressed-bytes hash before returning the parsed JSON.
 */
export function loadTranscriptPage(
  pack: Uint8Array,
  pageIndex: number,
  decompress: SessionBlobDecompressor,
): DecodedPageBody {
  const decoded = decodeSessionBlobPack(pack)
  const pageRef: SessionBlobPageRefV2 | undefined = decoded.header.pages[pageIndex]
  if (!pageRef) {
    throw new Error(`loadTranscriptPage: page ${pageIndex} not in pack (page_count=${decoded.header.page_count})`)
  }
  const compressed = decoded.pageBytes[pageIndex]!
  // Stored-bytes hash check.
  const storedHash = `blake3:${toHex(blake3(compressed))}`
  if (storedHash !== pageRef.stored_hash) {
    throw new Error(
      `loadTranscriptPage: page ${pageIndex} stored_hash mismatch (header=${pageRef.stored_hash} bytes=${storedHash})`,
    )
  }
  const uncompressed = decompress(compressed)
  if (uncompressed.length !== pageRef.uncompressed_length) {
    throw new Error(
      `loadTranscriptPage: page ${pageIndex} uncompressed_length mismatch (header=${pageRef.uncompressed_length} bytes=${uncompressed.length})`,
    )
  }
  const uncompressedHash = `blake3:${toHex(blake3(uncompressed))}`
  if (uncompressedHash !== pageRef.uncompressed_hash) {
    throw new Error(
      `loadTranscriptPage: page ${pageIndex} uncompressed_hash mismatch (header=${pageRef.uncompressed_hash} bytes=${uncompressedHash})`,
    )
  }
  return JSON.parse(new TextDecoder('utf-8').decode(uncompressed)) as DecodedPageBody
}

/**
 * Identity compressor/decompressor pair used by tests that want to
 * exercise framing, hashing, and pagination without involving zstd.
 */
export const identityCompressor = (b: Uint8Array): Uint8Array => b
export const identityDecompressor = (b: Uint8Array): Uint8Array => b

export interface TranscriptMessage {
  message_id: string
  ordinal: number
  role: string
  timestamp: string | null
  turn_id: string | null
  blocks: Array<{
    block_id: string
    block_type: string
    body: TranscriptTextBodyV2
  }>
  /** Page indices that contributed blocks to this message. Length > 1
   *  iff the message was fragmented across pages (adversarial
   *  single-message-too-large input). */
  page_indices: number[]
}

export interface TranscriptIteratorOptions {
  /** Inclusive lower ordinal bound. Pages whose
   *  `message_ordinal_end < startOrdinal` are skipped without
   *  decompression. */
  startOrdinal?: number
  /** Inclusive upper ordinal bound. Pages whose
   *  `message_ordinal_start > endOrdinal` are skipped without
   *  decompression. */
  endOrdinal?: number
}

/**
 * Iterate every message in the pack in canonical ordinal order,
 * coalescing fragments that share `(message_id, ordinal)` across
 * adjacent pages back into a single `TranscriptMessage`. Each page
 * is decompressed at most once, and pages outside the requested
 * `[startOrdinal, endOrdinal]` range are skipped without
 * decompression. Hashes are verified through `loadTranscriptPage`.
 *
 * Range filtering is applied after coalescing: a fragmented message
 * whose ordinal falls outside the range is dropped entirely, but a
 * fragment whose page intersects the range still triggers
 * decompression of that page.
 */
export function* iterateTranscript(
  pack: Uint8Array,
  decompress: SessionBlobDecompressor,
  options?: TranscriptIteratorOptions,
): Generator<TranscriptMessage, void, void> {
  const decoded = decodeSessionBlobPack(pack)
  const startOrdinal = options?.startOrdinal ?? Number.NEGATIVE_INFINITY
  const endOrdinal = options?.endOrdinal ?? Number.POSITIVE_INFINITY

  let pending: TranscriptMessage | null = null

  const emit = function* (message: TranscriptMessage): Generator<TranscriptMessage, void, void> {
    if (message.ordinal >= startOrdinal && message.ordinal <= endOrdinal) yield message
  }

  for (let i = 0; i < decoded.header.pages.length; i++) {
    const pageRef = decoded.header.pages[i]!
    // Skip pages that fall entirely below the requested window — but
    // only when no pending fragment from a prior page is still open
    // (a fragmented message may straddle the boundary).
    if (pending === null && pageRef.message_ordinal_end < startOrdinal) continue
    // Skip pages that fall entirely above the requested window.
    if (pageRef.message_ordinal_start > endOrdinal) break

    const body = loadTranscriptPage(pack, i, decompress)
    for (const msg of body.messages) {
      const sameAsPending = pending !== null && pending.message_id === msg.message_id && pending.ordinal === msg.ordinal
      if (sameAsPending) {
        pending!.blocks.push(...msg.blocks)
        pending!.page_indices.push(i)
        continue
      }
      if (pending !== null) yield* emit(pending)
      pending = {
        message_id: msg.message_id,
        ordinal: msg.ordinal,
        role: msg.role,
        timestamp: msg.timestamp,
        turn_id: msg.turn_id,
        blocks: msg.blocks.slice(),
        page_indices: [i],
      }
    }
  }
  if (pending !== null) yield* emit(pending)
}

/**
 * Collect-all helper for `iterateTranscript`. Use only when the
 * full transcript is known to fit in memory; the generator form is
 * preferred for paged-render flows.
 */
export function loadTranscript(
  pack: Uint8Array,
  decompress: SessionBlobDecompressor,
  options?: TranscriptIteratorOptions,
): TranscriptMessage[] {
  return Array.from(iterateTranscript(pack, decompress, options))
}

/**
 * Recompute the `pack_digest` from the framed pack bytes and verify
 * it matches the value carried in `header.pack_digest`. Returns the
 * recomputed digest. Throws on mismatch. The digest is defined as
 * `blake3(canonical_json(header_without_pack_digest_field) || payload)`,
 * so any reader can re-derive it from the bytes alone without
 * trusting the header field.
 */
export function verifyPackDigest(pack: Uint8Array): string {
  const decoded = decodeSessionBlobPack(pack)
  const { pack_digest: _stored, ...rest } = decoded.header
  const headerNoDigestBytes = canonicalJsonBytes(rest)
  const framing = decodeSessionBlobFrame(pack)
  const subject = new Uint8Array(headerNoDigestBytes.length + framing.payload.length)
  subject.set(headerNoDigestBytes, 0)
  subject.set(framing.payload, headerNoDigestBytes.length)
  const recomputed = `blake3:${toHex(blake3(subject))}`
  if (recomputed !== decoded.header.pack_digest) {
    throw new Error(`verifyPackDigest: mismatch (header=${decoded.header.pack_digest} recomputed=${recomputed})`)
  }
  return recomputed
}
