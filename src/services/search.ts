import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Bundle } from '../core/bundle.js'
import { getErrorMessage } from '../core/errors.js'
import { clampLimit } from '../core/limits.js'
import { type SearchEngine, getSearchIndexStatus } from './indexing.js'

const require = createRequire(import.meta.url)

/** Search result projected from either FTS5 or Tantivy into the common service shape. */
export interface SearchHit {
  /** Search document identifier. */
  doc_id: string
  /** Indexed entity kind. */
  entity_type: string
  /** Identifier of the indexed entity. */
  entity_id: string
  /** Session that owns the document, when applicable. */
  session_id: string | null
  /** Timestamp used for result ordering. */
  timestamp: string | null
  /** Message role associated with the document. */
  role: string | null
  /** Tool name associated with the document. */
  tool_name: string | null
  /** Indexed text field category. */
  field_kind: string
  /** Highlighted or truncated result snippet. */
  snippet: string
}

/** Options for full-text search across indexed conversation and tool evidence. */
export interface SearchOptions {
  /** Query text, interpreted by the selected engine. */
  query: string
  /** Maximum hit count, clamped by service limits. */
  limit?: number
  /** Search backend to query; defaults to FTS5. */
  engine?: SearchEngine
  /**
   * When true, pass `query` straight to FTS5 (MATCH expression). When false
   * (default), each whitespace-delimited token is wrapped in double quotes so
   * punctuation like `package.json` doesn't trip the FTS5 parser. Set true if
   * you want to use FTS5 operators like `OR`, `NEAR`, prefixes, etc.
   */
  raw?: boolean
}

/**
 * Wrap each whitespace-delimited token in double quotes so the FTS5 parser
 * treats them as phrases. This avoids syntax errors on punctuation that the
 * unicode61 tokenizer splits on (dots, slashes, hyphens, etc.) while still
 * AND-matching across tokens.
 */
function escapeFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ')
}

/** Runs full-text search with FTS5 by default, or Tantivy when requested. */
export function searchFullText(bundle: Bundle, options: SearchOptions): SearchHit[] {
  if (options.engine === 'tantivy') {
    return searchTantivy(bundle, options)
  }

  const limit = clampLimit(options.limit, { max: 500, fallback: 50 })
  const sql = `
    SELECT d.doc_id,
           d.entity_type,
           d.entity_id,
           d.session_id,
           d.timestamp,
           d.role,
           d.tool_name,
           d.field_kind,
           snippet(search_docs_fts, 0, '⟪', '⟫', '…', 12) AS snippet
      FROM search_docs_fts
      JOIN search_docs d ON d.rowid = search_docs_fts.rowid
     WHERE search_docs_fts MATCH ?
     ORDER BY bm25(search_docs_fts), d.timestamp DESC
     LIMIT ${limit}
  `
  const ftsQuery = options.raw ? options.query : escapeFtsQuery(options.query)
  if (!ftsQuery) return []
  return bundle.db.prepare(sql).all(ftsQuery) as SearchHit[]
}

/** Searches the Tantivy sidecar and maps stored fields back to {@link SearchHit}. */
function searchTantivy(bundle: Bundle, options: SearchOptions): SearchHit[] {
  if (!existsSync(bundle.paths.tantivy)) {
    throw new Error('tantivy index not found; run `prosa index tantivy` first')
  }

  const status = getSearchIndexStatus(bundle, 'tantivy')
  if (status?.status !== 'ready') {
    throw new Error(`tantivy index is ${status?.status ?? 'missing'}; run \`prosa index tantivy\` first`)
  }

  const limit = clampLimit(options.limit, { max: 500, fallback: 50 })
  const queryText = options.query.trim()
  if (!queryText) return []

  const tantivy = requireTantivy()
  const index = tantivy.Index.open(bundle.paths.tantivy)
  const searcher = index.searcher()
  const [query] = options.raw
    ? [index.parseQuery(queryText, ['text'])]
    : index.parseQueryLenient(queryText, ['text'], undefined, {
        text: [true, 2, true],
      })
  const result = searcher.search(query, limit, true)
  const snippets = tantivy.SnippetGenerator.create(searcher, query, index.schema, 'text')
  snippets.setMaxNumChars(180)

  return result.hits.map((hit: TantivySearchHit) => {
    const doc = searcher.doc(hit.docAddress)
    const snippet = snippets.snippetFromDoc(doc)
    const text = getStoredText(doc, 'text')
    const renderedSnippet = snippet.fragment()
      ? highlightSnippet(snippet.fragment(), snippet.highlighted())
      : text.slice(0, 180)
    return {
      doc_id: getStoredText(doc, 'doc_id'),
      entity_type: getStoredText(doc, 'entity_type'),
      entity_id: getStoredText(doc, 'entity_id'),
      session_id: nullIfEmpty(getStoredText(doc, 'session_id')),
      timestamp: nullIfEmpty(getStoredText(doc, 'timestamp')),
      role: nullIfEmpty(getStoredText(doc, 'role')),
      tool_name: nullIfEmpty(getStoredText(doc, 'tool_name')),
      field_kind: getStoredText(doc, 'field_kind'),
      snippet: renderedSnippet,
    }
  })
}

type TantivyModule = typeof import('@oxdev03/node-tantivy-binding')
type TantivyDocument = InstanceType<TantivyModule['Document']>
type TantivySearchHit = import('@oxdev03/node-tantivy-binding').SearchHit

/** Loads the optional Tantivy binding and normalizes missing-module failures. */
function requireTantivy(): TantivyModule {
  try {
    return require('@oxdev03/node-tantivy-binding') as TantivyModule
  } catch (error) {
    throw new Error(`tantivy engine is unavailable: ${getErrorMessage(error)}`)
  }
}

/** Reads a stored Tantivy text field across scalar and array binding shapes. */
function getStoredText(doc: TantivyDocument, field: string): string {
  const value = doc.getFirst(field)
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  if (value == null) return ''
  return String(value)
}

/** Converts Tantivy's empty-string null sentinel back to service-level null. */
function nullIfEmpty(value: string): string | null {
  return value.length > 0 ? value : null
}

/** Renders Tantivy highlight byte ranges with the same markers used by FTS5 snippets. */
function highlightSnippet(fragment: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return fragment

  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += fragment.slice(cursor, range.start)
    out += `⟪${fragment.slice(range.start, range.end)}⟫`
    cursor = range.end
  }
  out += fragment.slice(cursor)
  return out
}
