// Shared search_doc emitter for v2 importers.
//
// The Lane 3 compile-to-index gate requires every provider that
// produces `MessageV2` + `ContentBlockV2` rows to also populate
// `SearchDocV2` rows so the Tantivy runtime has something to
// index. v1 has a `buildSearchDocs` helper per provider; the v2
// port shares one helper here to keep the per-provider call sites
// identical and avoid drift between providers.
//
// This is the load-bearing subset of the v1 logic: one search_doc
// per message that has at least one indexable text content block.
// Tool-call / tool-result / per-block fan-out is intentionally
// out of scope for this slice — it lands when the v2 importers
// port their full v1 search_doc behaviour.

import type { CanonicalProjectionDraft } from './types.js'

/** Block types whose `text_inline` payload is indexable. Mirrors
 *  the v1 `buildSearchDocs` filter (codex / claude / cursor /
 *  gemini / hermes variants all agree on this set). */
const INDEXABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['input_text', 'output_text', 'text'])

/**
 * Walk the projection draft's messages + content blocks and append
 * one `SearchDocV2` per message that has at least one indexable
 * text block. Each row carries the message's session_id, timestamp,
 * and role; the `field_kind` is `user_prompt` for user messages
 * and `assistant_text` otherwise (matches v1's codex/claude
 * variant). Blocks with `null`/empty `text_inline` are skipped.
 *
 * The function mutates `draft.search_docs` in place. It is
 * idempotent only insofar as `draft.search_docs` is empty on entry;
 * callers should run it once per session import.
 */
export function buildSearchDocsFromMessageBlocks(draft: CanonicalProjectionDraft): void {
  const blocksByMessage = new Map<string, string[]>()
  for (const block of draft.content_blocks) {
    const textInline = block.text_inline
    if (typeof textInline !== 'string' || textInline.length === 0) continue
    if (!INDEXABLE_BLOCK_TYPES.has(block.block_type)) continue
    const mid = block.message_id
    if (mid === null) continue
    const list = blocksByMessage.get(mid) ?? []
    list.push(textInline)
    blocksByMessage.set(mid, list)
  }
  for (const message of draft.messages) {
    const texts = blocksByMessage.get(message.message_id)
    if (texts === undefined || texts.length === 0) continue
    const text = texts.join('\n')
    draft.search_docs.push({
      doc_id: `msg:${message.message_id}`,
      entity_type: 'message',
      entity_id: message.message_id,
      session_id: message.session_id,
      project_id: null,
      timestamp: message.timestamp,
      role: message.role,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: message.role === 'user' ? 'user_prompt' : 'assistant_text',
      errors_only: false,
      text,
    })
  }
}
