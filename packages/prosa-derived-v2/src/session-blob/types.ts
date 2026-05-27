// SessionBlobPackV2 — paged transcript packs.
//
// One pack per session per epoch. Pages bound page payload to
// `MAX_PAGE_UNCOMPRESSED_BYTES`, individual inline content blocks to
// `MAX_INLINE_BLOCK_BYTES`, and message count per page to
// `HARD_MESSAGES_PER_PAGE`. Larger content bodies move to CAS by
// reference with a bounded preview.
//
// See `docs/rearch-2/04-lane-3-derived-layer.md` for the lean-profile
// joint constraint these constants encode.

/** 1 MiB hard cap on uncompressed page payload bytes. */
export const MAX_PAGE_UNCOMPRESSED_BYTES = 1024 * 1024
/** 512 KiB target page payload — the writer prefers splitting near
 *  this size when message-count + byte-budget agree. */
export const TARGET_PAGE_UNCOMPRESSED_BYTES = 512 * 1024
/** Soft message-count target per page. */
export const TARGET_MESSAGES_PER_PAGE = 128
/** Hard message-count cap per page. */
export const HARD_MESSAGES_PER_PAGE = 256
/** Per-block inline cap. Anything strictly larger lands as a CAS ref. */
export const MAX_INLINE_BLOCK_BYTES = 32 * 1024

/** Inline preview cap for a CAS-ref body. */
export const CAS_REF_PREVIEW_MAX_BYTES = 4096

/** Top-level pack header, written once per session pack. */
export type SessionBlobPackHeaderV2 = {
  pack_digest: string
  compression: 'zstd'
  epoch: number
  page_count: number
  pages: SessionBlobPageRefV2[]
}

/** Pack index entry describing one paged-transcript record. */
export type SessionBlobPageRefV2 = {
  page_id: string
  session_id: string
  page_index: number
  message_ordinal_start: number
  message_ordinal_end: number
  message_count: number
  turn_count: number
  tool_call_count: number
  stored_offset: number
  stored_length: number
  uncompressed_length: number
  stored_hash: string
  uncompressed_hash: string
}

/** Canonical text body container — either inline up to
 *  `MAX_INLINE_BLOCK_BYTES`, or a CAS reference with a bounded preview. */
export type TranscriptTextBodyV2 =
  | { kind: 'inline'; text: string; byte_length: number }
  | {
      kind: 'cas_ref'
      object_id: string
      byte_length: number
      preview: string
      mime_type?: string
    }
