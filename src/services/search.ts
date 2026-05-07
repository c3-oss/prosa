import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Bundle } from '../core/bundle.js';
import { getErrorMessage } from '../core/errors.js';
import { clampLimit } from '../core/limits.js';
import { type SearchEngine, getSearchIndexStatus } from './indexing.js';

const require = createRequire(import.meta.url);

export interface SearchHit {
  doc_id: string;
  entity_type: string;
  entity_id: string;
  session_id: string | null;
  timestamp: string | null;
  role: string | null;
  tool_name: string | null;
  field_kind: string;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  engine?: SearchEngine;
  /**
   * When true, pass `query` straight to FTS5 (MATCH expression). When false
   * (default), each whitespace-delimited token is wrapped in double quotes so
   * punctuation like `package.json` doesn't trip the FTS5 parser. Set true if
   * you want to use FTS5 operators like `OR`, `NEAR`, prefixes, etc.
   */
  raw?: boolean;
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
    .join(' ');
}

/**
 * FTS5 search over messages, tool calls and tool outputs. Caller passes a
 * raw FTS5 MATCH query. We project a snippet around the hit and join with
 * search_docs to recover entity metadata.
 */
export function searchFullText(bundle: Bundle, options: SearchOptions): SearchHit[] {
  if (options.engine === 'tantivy') {
    return searchTantivy(bundle, options);
  }

  const limit = clampLimit(options.limit, { max: 500, fallback: 50 });
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
  `;
  const ftsQuery = options.raw ? options.query : escapeFtsQuery(options.query);
  if (!ftsQuery) return [];
  return bundle.db.prepare(sql).all(ftsQuery) as SearchHit[];
}

function searchTantivy(bundle: Bundle, options: SearchOptions): SearchHit[] {
  if (!existsSync(bundle.paths.tantivy)) {
    throw new Error('tantivy index not found; run `prosa index tantivy` first');
  }

  const status = getSearchIndexStatus(bundle, 'tantivy');
  if (status?.status !== 'ready') {
    throw new Error(
      `tantivy index is ${status?.status ?? 'missing'}; run \`prosa index tantivy\` first`,
    );
  }

  const limit = clampLimit(options.limit, { max: 500, fallback: 50 });
  const queryText = options.query.trim();
  if (!queryText) return [];

  const tantivy = requireTantivy();
  const index = tantivy.Index.open(bundle.paths.tantivy);
  const searcher = index.searcher();
  const [query] = options.raw
    ? [index.parseQuery(queryText, ['text'])]
    : index.parseQueryLenient(queryText, ['text'], undefined, {
        text: [true, 2, true],
      });
  const result = searcher.search(query, limit, true);
  const snippets = tantivy.SnippetGenerator.create(searcher, query, index.schema, 'text');
  snippets.setMaxNumChars(180);

  return result.hits.map((hit: TantivySearchHit) => {
    const doc = searcher.doc(hit.docAddress);
    const snippet = snippets.snippetFromDoc(doc);
    const text = getStoredText(doc, 'text');
    const renderedSnippet = snippet.fragment()
      ? highlightSnippet(snippet.fragment(), snippet.highlighted())
      : text.slice(0, 180);
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
    };
  });
}

type TantivyModule = typeof import('@oxdev03/node-tantivy-binding');
type TantivyDocument = InstanceType<TantivyModule['Document']>;
type TantivySearchHit = import('@oxdev03/node-tantivy-binding').SearchHit;

function requireTantivy(): TantivyModule {
  try {
    return require('@oxdev03/node-tantivy-binding') as TantivyModule;
  } catch (error) {
    throw new Error(`tantivy engine is unavailable: ${getErrorMessage(error)}`);
  }
}

function getStoredText(doc: TantivyDocument, field: string): string {
  const value = doc.getFirst(field);
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  if (value == null) return '';
  return String(value);
}

function nullIfEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}

function highlightSnippet(fragment: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return fragment;

  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += fragment.slice(cursor, range.start);
    out += `⟪${fragment.slice(range.start, range.end)}⟫`;
    cursor = range.end;
  }
  out += fragment.slice(cursor);
  return out;
}
