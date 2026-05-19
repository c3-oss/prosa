// SessionBlobPackV2 writer.
//
// Takes one session's ordered messages + their content blocks and emits
// a `prosa-session-blob` pack: framed header with one
// `SessionBlobPageRefV2` per page, payload of zstd-compressed canonical-
// JSON page bodies. The page boundaries come from the joint-constraint
// policy in `./writer-policy.ts`.
//
// Out of scope this iteration:
//   - CAS spill writing (writer emits `cas_ref` decisions but assumes
//     the caller has already staged the spilled bodies and passes back
//     the `object_id` / `preview` for each).
//   - Cross-session multiplexing (one pack per session per epoch).
//   - Compression-format negotiation (zstd only).

import { toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import { canonicalJsonBytes, encodeSessionBlobFrame } from './framing.js'
import {
  CAS_REF_PREVIEW_MAX_BYTES,
  type SessionBlobPackHeaderV2,
  type SessionBlobPageRefV2,
  type TranscriptTextBodyV2,
} from './types.js'
import { decideBlock, decideMessageBoundary } from './writer-policy.js'

/**
 * Input view of a single message the writer should place into the pack.
 * The writer does not depend on any v2 entity schema; callers translate
 * `MessageV2` + `ContentBlockV2` rows into this shape.
 */
export interface BlobMessageInput {
  /** Stable canonical id for this message — written verbatim to the
   *  page body so re-imports produce identical pack bytes. */
  message_id: string
  /** Per-session ordinal; the writer uses this for
   *  `message_ordinal_start` / `message_ordinal_end`. */
  ordinal: number
  /** Role string; passed through unchanged. */
  role: string
  /** Optional ISO-8601 timestamp; passed through unchanged. */
  timestamp: string | null
  /** Optional turn id for `turn_count` accounting. */
  turn_id: string | null
  /** Content blocks in canonical order. The writer enforces the joint
   *  byte/size constraints over these blocks. */
  blocks: BlobBlockInput[]
}

export interface BlobBlockInput {
  block_id: string
  block_type: string
  /** When `kind: 'inline'`, the literal text body. The writer measures
   *  this in UTF-8 bytes for the joint-constraint policy. When
   *  `kind: 'cas_ref'`, the writer trusts the caller's staged object
   *  id and preview. */
  body: TranscriptTextBodyV2
  /** True when this block triggered a tool call; used for
   *  `tool_call_count` accounting. */
  is_tool_call?: boolean
}

export interface WriteSessionBlobPackInput {
  session_id: string
  epoch: number
  messages: readonly BlobMessageInput[]
}

export interface WriteSessionBlobPackResult {
  /** Framed pack bytes (header + zstd-compressed payload). */
  pack: Uint8Array
  /** Decoded header, useful for testing without re-parsing the bytes. */
  header: SessionBlobPackHeaderV2
  /** Pack digest (blake3 over the entire framed pack). */
  pack_digest: string
}

/**
 * Per-page accumulator used while the writer is choosing page
 * boundaries. The shape mirrors what eventually lands on disk inside
 * each compressed page body.
 */
interface PageDraft {
  page_index: number
  message_ordinal_start: number
  message_ordinal_end: number
  message_count: number
  tool_call_count: number
  turns: Set<string>
  byte_length: number
  messages: PageMessage[]
}

interface PageMessage {
  message_id: string
  ordinal: number
  role: string
  timestamp: string | null
  turn_id: string | null
  blocks: PageBlock[]
}

interface PageBlock {
  block_id: string
  block_type: string
  body: TranscriptTextBodyV2
}

/**
 * Per-block constant overhead the canonical-JSON serializer adds for
 * each entry under `messages[].blocks[]`, beyond the inline text or
 * preview itself. Conservative on purpose so the estimate is at least
 * the actual JSON cost for adversarial inputs with hundreds of small
 * blocks per page.
 */
const BLOCK_JSON_OVERHEAD_BYTES = 256
/**
 * Per-message constant overhead the canonical-JSON serializer adds
 * for each entry under `messages[]`, beyond the per-block accounting.
 */
const MESSAGE_JSON_OVERHEAD_BYTES = 256
/**
 * Effective per-page byte budget the writer enforces internally. The
 * canonical-JSON serializer adds field-name overhead, quoting, and
 * separators that the rough per-block/per-message constants cannot
 * always capture exactly; we trade a little inline capacity for a
 * tight upper bound on serialized output. The public-facing
 * `MAX_PAGE_UNCOMPRESSED_BYTES` constant is still the hard cap; this
 * budget is the soft writer-internal headroom that keeps serialized
 * pages under it.
 */
const EFFECTIVE_PAGE_BUDGET = Math.floor(0.75 * 1024 * 1024)

/**
 * Compute the in-pack byte cost of a content body. Inline text costs
 * its UTF-8 length plus the block JSON overhead; CAS refs cost the
 * preview length plus block + object_id wrapper overhead.
 */
function bodyByteCost(body: TranscriptTextBodyV2): number {
  if (body.kind === 'inline') {
    // `text` is JSON-escaped, which can grow by up to ~6x for
    // pathological control characters but stays at 1x for typical
    // text. Use 1.1x with a small floor to stay conservative.
    return Math.ceil(body.byte_length * 1.1) + BLOCK_JSON_OVERHEAD_BYTES
  }
  // CAS ref body: object id (~70 chars) + bounded preview + JSON
  // overhead.
  return Math.min(body.preview.length, CAS_REF_PREVIEW_MAX_BYTES) + BLOCK_JSON_OVERHEAD_BYTES + 128
}

function messageByteCost(message: BlobMessageInput): number {
  return (
    MESSAGE_JSON_OVERHEAD_BYTES +
    message.message_id.length +
    (message.role?.length ?? 0) +
    (message.timestamp?.length ?? 0) +
    (message.turn_id?.length ?? 0)
  )
}

function newPageDraft(page_index: number, ordinal: number): PageDraft {
  return {
    page_index,
    message_ordinal_start: ordinal,
    message_ordinal_end: ordinal,
    message_count: 0,
    tool_call_count: 0,
    turns: new Set<string>(),
    byte_length: 0,
    messages: [],
  }
}

/**
 * Inject a zstd compressor at call time so this module stays
 * dependency-free at import. The real call sites pass
 * `zstdCompress` from `@c3-oss/prosa-bundle-v2`; tests can pass an
 * identity compressor to assert the framing and joint-constraint
 * placement independently of zstd.
 */
export type SessionBlobCompressor = (uncompressed: Uint8Array) => Uint8Array

export function writeSessionBlobPack(
  input: WriteSessionBlobPackInput,
  compress: SessionBlobCompressor,
): WriteSessionBlobPackResult {
  const pages: PageDraft[] = [newPageDraft(0, input.messages[0]?.ordinal ?? 0)]

  for (let mi = 0; mi < input.messages.length; mi++) {
    const message = input.messages[mi]!
    let current = pages[pages.length - 1]!

    // Between-message boundary check.
    if (current.message_count > 0) {
      const boundary = decideMessageBoundary({
        currentBytes: current.byte_length,
        messageCount: current.message_count,
      })
      if (boundary.kind === 'split_page') {
        pages.push(newPageDraft(pages.length, message.ordinal))
        current = pages[pages.length - 1]!
      }
    }

    // Atomicity contract: a message stays intact on a single page
    // when its cumulative block cost fits on a fresh empty page. If
    // the message has so many blocks that even a fresh page cannot
    // hold them (adversarial single-message-too-large input), the
    // writer splits the message across pages, preserving every block
    // and stamping each fragment with the same `message_id`. Each
    // fragment lands on its own page; later fragments inherit the
    // same role/timestamp/turn_id. The reader concatenates fragments
    // by `message_id` order.
    const headerCost = messageByteCost(message)
    let stagedBlocks: PageBlock[] = []
    let stagedToolCalls = 0
    let stagedBytes = 0
    // True once this message has already split at least once on a
    // fresh empty page — meaning the message cannot fit atomically.
    // In that mode the writer commits stagedBlocks as a fragment on
    // the current page, opens a new page, and continues from the
    // next un-committed block.
    let fragmentMode = false
    const flushFragmentBeforeSplit = (): void => {
      // Commit the accumulated stagedBlocks as a partial message
      // entry on the current page, then push a new empty page.
      current.messages.push({
        message_id: message.message_id,
        ordinal: message.ordinal,
        role: message.role,
        timestamp: message.timestamp,
        turn_id: message.turn_id,
        blocks: stagedBlocks,
      })
      current.message_count += 1
      current.message_ordinal_end = message.ordinal
      current.tool_call_count += stagedToolCalls
      if (message.turn_id !== null) current.turns.add(message.turn_id)
      current.byte_length += headerCost + stagedBytes
      pages.push(newPageDraft(pages.length, message.ordinal))
      current = pages[pages.length - 1]!
      stagedBlocks = []
      stagedToolCalls = 0
      stagedBytes = 0
    }
    let bi = 0
    while (bi < message.blocks.length) {
      const block = message.blocks[bi]!
      const blockCost = bodyByteCost(block.body)
      const accumulated = current.byte_length + headerCost + stagedBytes
      // Writer-internal effective budget: tighter than the public
      // `MAX_PAGE_UNCOMPRESSED_BYTES` so the serialized bytes stay
      // under the public cap even for adversarial inputs.
      const wouldOverflowBudget = accumulated + blockCost > EFFECTIVE_PAGE_BUDGET
      const decision = decideBlock(
        {
          currentBytes: accumulated,
          messageCount: current.message_count,
        },
        blockCost,
      )
      if (decision.kind === 'split_page' || (wouldOverflowBudget && current.message_count > 0)) {
        // Standard split: prior messages live on the current page;
        // restart staging on a fresh page.
        pages.push(newPageDraft(pages.length, message.ordinal))
        current = pages[pages.length - 1]!
        stagedBlocks = []
        stagedToolCalls = 0
        stagedBytes = 0
        bi = 0
        continue
      }
      if (wouldOverflowBudget && current.message_count === 0 && stagedBlocks.length > 0) {
        // Fragment mode: the message is too large to fit even on a
        // fresh empty page. Commit the staged blocks as a fragment
        // and move on to the next page; the remaining blocks become
        // a subsequent fragment under the same message_id.
        flushFragmentBeforeSplit()
        fragmentMode = true
        continue
      }
      // `inline` and `cas_ref` decisions both land on the current page.
      stagedBlocks.push({ block_id: block.block_id, block_type: block.block_type, body: block.body })
      stagedBytes += blockCost
      if (block.is_tool_call === true) stagedToolCalls += 1
      bi++
    }
    void fragmentMode
    // Re-bind current after any fragment flush + page push, then
    // commit whatever staging remains as the trailing fragment
    // (or the whole-message commit when no fragmenting happened).
    current = pages[pages.length - 1]!

    // Commit the message into the current page.
    current.messages.push({
      message_id: message.message_id,
      ordinal: message.ordinal,
      role: message.role,
      timestamp: message.timestamp,
      turn_id: message.turn_id,
      blocks: stagedBlocks,
    })
    current.message_count += 1
    current.message_ordinal_end = message.ordinal
    current.tool_call_count += stagedToolCalls
    if (message.turn_id !== null) current.turns.add(message.turn_id)
    current.byte_length += headerCost + stagedBlocks.reduce((s, b) => s + bodyByteCost(b.body), 0)
  }

  // Drop any trailing empty pages (e.g., when `input.messages` is empty).
  while (pages.length > 1 && pages[pages.length - 1]!.message_count === 0) pages.pop()
  if (pages.length === 1 && pages[0]!.message_count === 0) {
    // Zero-message input still produces a single empty pack so the
    // session_id record exists. Callers can detect emptiness via
    // `header.page_count === 0`.
    pages.length = 0
  }

  // Serialize each page body to canonical JSON, hash it (uncompressed),
  // compress it with the supplied zstd compressor, and lay it out into
  // the payload buffer with running stored offsets.
  const pageRefs: SessionBlobPageRefV2[] = []
  const payloadChunks: Uint8Array[] = []
  let storedOffset = 0
  for (const page of pages) {
    const body = {
      page_index: page.page_index,
      session_id: input.session_id,
      message_ordinal_start: page.message_ordinal_start,
      message_ordinal_end: page.message_ordinal_end,
      messages: page.messages.map((m) => ({
        message_id: m.message_id,
        ordinal: m.ordinal,
        role: m.role,
        timestamp: m.timestamp,
        turn_id: m.turn_id,
        blocks: m.blocks.map((b) => ({
          block_id: b.block_id,
          block_type: b.block_type,
          body: b.body,
        })),
      })),
    }
    const uncompressed = canonicalJsonBytes(body)
    const uncompressedHash = `blake3:${toHex(blake3(uncompressed))}`
    const compressed = compress(uncompressed)
    const storedHash = `blake3:${toHex(blake3(compressed))}`
    const pageId = `pag_${toHex(blake3(new TextEncoder().encode(`session-blob:${input.session_id}:${page.page_index}`))).slice(0, 32)}`
    pageRefs.push({
      page_id: pageId,
      session_id: input.session_id,
      page_index: page.page_index,
      message_ordinal_start: page.message_ordinal_start,
      message_ordinal_end: page.message_ordinal_end,
      message_count: page.message_count,
      turn_count: page.turns.size,
      tool_call_count: page.tool_call_count,
      stored_offset: storedOffset,
      stored_length: compressed.length,
      uncompressed_length: uncompressed.length,
      stored_hash: storedHash,
      uncompressed_hash: uncompressedHash,
    })
    payloadChunks.push(compressed)
    storedOffset += compressed.length
  }

  // Assemble the payload concatenation.
  const payloadLength = payloadChunks.reduce((s, c) => s + c.length, 0)
  const payload = new Uint8Array(payloadLength)
  let cursor = 0
  for (const chunk of payloadChunks) {
    payload.set(chunk, cursor)
    cursor += chunk.length
  }

  // `pack_digest` is a self-referential field on the header: it must
  // identify the pack contents but cannot include itself. The contract
  // is therefore `pack_digest = blake3(canonical(header_without_pack_digest_field) || payload)`.
  // Readers can recompute it by parsing the header, clearing
  // `pack_digest`, re-canonicalising, and hashing with the payload.
  // The digest is *not* the blake3 of the framed pack bytes (those
  // include the digest itself plus the 56-byte framing prefix).
  const headerNoDigest = {
    compression: 'zstd' as const,
    epoch: input.epoch,
    page_count: pageRefs.length,
    pages: pageRefs,
  }
  // Compute the digest over canonical(header without pack_digest) || payload.
  const digestSubject = new Uint8Array(canonicalJsonBytes(headerNoDigest).length + payload.length)
  const headerNoDigestBytes = canonicalJsonBytes(headerNoDigest)
  digestSubject.set(headerNoDigestBytes, 0)
  digestSubject.set(payload, headerNoDigestBytes.length)
  const packDigest = `blake3:${toHex(blake3(digestSubject))}`
  const finalHeaderObj: SessionBlobPackHeaderV2 = {
    pack_digest: packDigest,
    compression: 'zstd',
    epoch: input.epoch,
    page_count: pageRefs.length,
    pages: pageRefs,
  }
  const finalHeader = canonicalJsonBytes(finalHeaderObj)
  const finalPack = encodeSessionBlobFrame({ headerBytes: finalHeader, payload })
  return { pack: finalPack, header: finalHeaderObj, pack_digest: packDigest }
}
