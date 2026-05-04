import type { Bundle } from '../core/bundle.js';

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
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
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
