// Local-bundle implementation of `prosa read search <query>`.
//
// The Tantivy index materialised by `runTantivyRebuildForBundle` lives
// in `<bundleRoot>/derived/tantivy/`, but the native query reader is
// not yet exposed at the package surface. For the local read service
// we fall back to a streaming substring/regex scan over
// `search_doc.prosa-projection.ndjson` — the same source the
// Tantivy writer consumed. That is slower than a real index lookup
// for large bundles but unblocks `read search --authority local`
// without dragging the Tantivy query path into this PR.

import { loadBundleHead } from './head.js'
import { iterateProjectionRows } from './ndjson-stream.js'

export type LocalSearchRow = {
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string | null
  project_id: string | null
  timestamp: string | null
  role: string | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: string
  text: string
  /** Bounded snippet of the matched text. */
  snippet: string
}

export type SearchLocalOptions = {
  bundleRoot: string
  /** Free-text query. The local scan does a case-insensitive substring
   *  match against the `text` column; pass an empty string to disable
   *  the text filter and only apply structural filters. */
  query: string
  limit: number
}

const SNIPPET_BEFORE = 80
const SNIPPET_AFTER = 200

function snippet(text: string, queryLower: string): string {
  if (queryLower.length === 0) return text.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER)
  const lower = text.toLowerCase()
  const idx = lower.indexOf(queryLower)
  if (idx < 0) return text.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER)
  const start = Math.max(0, idx - SNIPPET_BEFORE)
  const end = Math.min(text.length, idx + queryLower.length + SNIPPET_AFTER)
  return text.slice(start, end)
}

/**
 * Stream the bundle's search_doc projection segment and return the
 * first `limit` rows whose `text` field contains the (lower-cased)
 * query string. Matching is purely lexical; Tantivy-style ranking +
 * field-specific operators stay behind the remote API for now.
 */
export async function searchLocal(options: SearchLocalOptions): Promise<{
  rows: LocalSearchRow[]
  epoch: number
}> {
  const head = await loadBundleHead(options.bundleRoot)
  const queryLower = options.query.toLowerCase()
  const out: LocalSearchRow[] = []
  for await (const row of iterateProjectionRows(options.bundleRoot, head.epoch, 'search_doc')) {
    const text = typeof row.text === 'string' ? row.text : ''
    if (queryLower.length > 0 && !text.toLowerCase().includes(queryLower)) continue
    out.push({
      doc_id: typeof row.doc_id === 'string' ? row.doc_id : '',
      entity_type: typeof row.entity_type === 'string' ? row.entity_type : '',
      entity_id: typeof row.entity_id === 'string' ? row.entity_id : '',
      session_id: typeof row.session_id === 'string' ? row.session_id : null,
      project_id: typeof row.project_id === 'string' ? row.project_id : null,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
      role: typeof row.role === 'string' ? row.role : null,
      tool_name: typeof row.tool_name === 'string' ? row.tool_name : null,
      canonical_tool_type: typeof row.canonical_tool_type === 'string' ? row.canonical_tool_type : null,
      field_kind: typeof row.field_kind === 'string' ? row.field_kind : '',
      text,
      snippet: snippet(text, queryLower),
    })
    if (out.length >= options.limit) break
  }
  return { rows: out, epoch: head.epoch }
}
