// SessionBlobPackV2 projection-to-input bridge.
//
// `writeSessionBlobPack` takes its own minimal input shape
// (`BlobMessageInput`) so the writer stays decoupled from the v2
// canonical entity schema. This module is the glue: it takes a
// session's canonical projection rows (`MessageV2[]` +
// `ContentBlockV2[]` + optional `ToolCallV2[]`) and produces the
// ordered list of `BlobMessageInput` the writer consumes.
//
// The bridge is pure: no I/O, no CAS staging, no compressor calls.
// CAS staging of oversized inline bodies is the *importer's* or the
// derived runtime's responsibility — by the time a `ContentBlockV2`
// reaches this bridge, the caller has already decided whether the
// body should be inlined (set `text_inline`) or referenced via
// `text_object_id` with a bounded preview.

import type { ContentBlockV2, MessageV2, ToolCallV2 } from '@c3-oss/prosa-types-v2'

import { CAS_REF_PREVIEW_MAX_BYTES, type TranscriptTextBodyV2 } from './types.js'
import type { BlobMessageInput } from './writer.js'

export interface ProjectionToSessionBlobInputs {
  session_id: string
  messages: readonly MessageV2[]
  content_blocks: readonly ContentBlockV2[]
  /** Optional tool calls; used to tag blocks whose `block_id` is
   *  referenced as a tool_use so the writer's `tool_call_count`
   *  accounting on each page reflects reality. */
  tool_calls?: readonly ToolCallV2[]
}

/**
 * Convert canonical v2 projection rows for one session into the
 * `BlobMessageInput[]` the SessionBlobPackV2 writer consumes. Only
 * rows whose `session_id` matches `input.session_id` are kept;
 * cross-session leakage is filtered out so callers can pass a
 * full-epoch slab safely.
 *
 * Sort order:
 *   - Messages by `ordinal`, then by `message_id` (stable secondary
 *     sort for deterministic output when ordinals collide).
 *   - Blocks per message by `ordinal`, then by `block_id`.
 *
 * Block body classification:
 *   - When `text_inline` is set, emit `kind: 'inline'`.
 *   - When `text_object_id` is set (without inline body, or with
 *     inline body that's just a preview), emit `kind: 'cas_ref'`.
 *   - When both are present, prefer the CAS ref (the inline value is
 *     treated as a bounded preview), since the canonical body lives
 *     in CAS.
 *   - When neither is present, emit an empty inline body so the
 *     writer still records the block at the correct ordinal.
 */
export function projectionToSessionBlobInputs(input: ProjectionToSessionBlobInputs): BlobMessageInput[] {
  const sessionMessages = input.messages
    .filter((m) => m.session_id === input.session_id)
    .slice()
    .sort((a, b) => {
      if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal
      return a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0
    })

  const blocksByMessage = new Map<string, ContentBlockV2[]>()
  for (const block of input.content_blocks) {
    if (block.session_id !== input.session_id) continue
    if (block.message_id === null) continue
    const list = blocksByMessage.get(block.message_id) ?? []
    list.push(block)
    blocksByMessage.set(block.message_id, list)
  }
  for (const list of blocksByMessage.values()) {
    list.sort((a, b) => {
      if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal
      return a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0
    })
  }

  // Tag block_ids that back tool calls so the page's tool_call_count
  // matches reality.
  const toolCallBlockIds = new Set<string>()
  if (input.tool_calls) {
    const blocksById = new Map<string, ContentBlockV2>()
    for (const block of input.content_blocks) {
      if (block.session_id !== input.session_id) continue
      blocksById.set(block.block_id, block)
    }
    for (const call of input.tool_calls) {
      if (call.session_id !== input.session_id) continue
      // The v2 schema does not store a back-reference from
      // `ToolCallV2` to its content block (the link is the other
      // direction: `ContentBlockV2.block_type === 'tool_use'` and the
      // owning message). Best-effort heuristic: when a tool call has
      // a `message_id`, mark the message's `tool_use` blocks as
      // tool-call-bearing.
      if (call.message_id !== null) {
        const list = blocksByMessage.get(call.message_id)
        if (!list) continue
        for (const block of list) {
          if (block.block_type === 'tool_use') toolCallBlockIds.add(block.block_id)
        }
      }
    }
    void blocksById
  }

  const out: BlobMessageInput[] = []
  for (const message of sessionMessages) {
    const blocks = blocksByMessage.get(message.message_id) ?? []
    out.push({
      message_id: message.message_id,
      ordinal: message.ordinal,
      role: message.role,
      timestamp: message.timestamp,
      turn_id: message.turn_id,
      blocks: blocks.map((block) => ({
        block_id: block.block_id,
        block_type: block.block_type,
        body: blockBody(block),
        is_tool_call: toolCallBlockIds.has(block.block_id) ? true : undefined,
      })),
    })
  }
  return out
}

function blockBody(block: ContentBlockV2): TranscriptTextBodyV2 {
  // CAS ref wins when the canonical body lives in CAS; the inline
  // text (when present) is a bounded preview, truncated by UTF-8
  // byte length (NOT String.slice, which counts UTF-16 code units
  // and can let multi-byte characters blow past the byte cap).
  if (block.text_object_id !== null && block.text_object_id !== undefined) {
    const rawPreview = block.text_inline ?? ''
    const preview = truncateToUtf8Bytes(rawPreview, CAS_REF_PREVIEW_MAX_BYTES)
    return {
      kind: 'cas_ref',
      object_id: block.text_object_id,
      // The caller knows the actual uncompressed body size; without
      // that information here, we conservatively report the preview
      // byte length so accounting at the writer level still makes
      // sense for the `cas_ref` cost estimate.
      byte_length: utf8ByteLength(preview),
      preview,
      mime_type: block.mime_type ?? undefined,
    }
  }
  const text = block.text_inline ?? ''
  return {
    kind: 'inline',
    text,
    byte_length: utf8ByteLength(text),
  }
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without
 * splitting a Unicode scalar. `TextEncoder.encodeInto` writes only
 * complete code points within the target buffer, so the returned
 * slice is guaranteed to round-trip back to a valid string and not
 * exceed `maxBytes`.
 *
 * Returns the original string when it already fits.
 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  // Fast path: ASCII never needs splitting.
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= maxBytes) return text
  const buffer = new Uint8Array(maxBytes)
  const result = new TextEncoder().encodeInto(text, buffer)
  // `result.read` is the number of source code units consumed; slicing
  // by that count yields a valid string whose UTF-8 form is `result.written`
  // bytes — always ≤ maxBytes since encodeInto stops on the last code
  // point that fits.
  return text.slice(0, result.read)
}
