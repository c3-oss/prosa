import type { SearchEngine } from '../services/indexing.js';

export { parseOutputFormat } from './output.js';

export type McpTransport = 'stdio' | 'http';

export function parseSearchEngine(value: string): SearchEngine {
  if (value === 'fts5' || value === 'tantivy') return value;
  throw new Error(`invalid search engine: ${value} (expected fts5 or tantivy)`);
}

export function parseMcpTransport(value: string): McpTransport {
  if (value === 'stdio' || value === 'http') return value;
  throw new Error(`invalid transport: ${value} (expected stdio or http)`);
}
