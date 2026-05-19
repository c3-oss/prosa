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
