import { SOURCE_TOOLS, type SearchEngine, type SourceTool } from '@c3-oss/prosa-core'

export { parseOutputFormat } from './output.js'

/** MCP transports supported by the `prosa mcp serve` command. */
export type McpTransport = 'stdio' | 'http'

/** Parse and validate a search engine CLI option. */
export function parseSearchEngine(value: string): SearchEngine {
  if (value === 'fts5' || value === 'tantivy') return value
  throw new Error(`invalid search engine: ${value} (expected fts5 or tantivy)`)
}

/** Parse and validate an MCP transport CLI option. */
export function parseMcpTransport(value: string): McpTransport {
  if (value === 'stdio' || value === 'http') return value
  throw new Error(`invalid transport: ${value} (expected stdio or http)`)
}

/** Parse an optional source tool filter from CLI input. */
export function parseSourceTool(value: string | undefined): SourceTool | undefined {
  if (value === undefined) return undefined
  if ((SOURCE_TOOLS as readonly string[]).includes(value)) return value as SourceTool
  throw new Error(`invalid source tool: ${value} (expected one of ${SOURCE_TOOLS.join(', ')})`)
}
