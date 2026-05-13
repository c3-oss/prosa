import { SOURCE_TOOLS, type SourceTool } from '../core/domain/types.js'
import type { SearchEngine } from '../services/indexing.js'

export { parseOutputFormat } from './output.js'

export type McpTransport = 'stdio' | 'http'

export function parseSearchEngine(value: string): SearchEngine {
  if (value === 'fts5' || value === 'tantivy') return value
  throw new Error(`invalid search engine: ${value} (expected fts5 or tantivy)`)
}

export function parseMcpTransport(value: string): McpTransport {
  if (value === 'stdio' || value === 'http') return value
  throw new Error(`invalid transport: ${value} (expected stdio or http)`)
}

export function parseSourceTool(value: string | undefined): SourceTool | undefined {
  if (value === undefined) return undefined
  if ((SOURCE_TOOLS as readonly string[]).includes(value)) return value as SourceTool
  throw new Error(`invalid source tool: ${value} (expected one of ${SOURCE_TOOLS.join(', ')})`)
}
