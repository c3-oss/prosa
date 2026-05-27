// v2 MCP server — local-bundle backed.
//
// `prosa mcp-v2 serve --authority local` lands here. The server
// registers a small set of v2-aware tools (`prosa.sessions`,
// `prosa.transcript`, `prosa.search`, `prosa.tool_calls`,
// `prosa.analytics`, `prosa.query`) and routes them through the
// `local-reads/*` services that already back the `prosa read *`
// CLI commands. The same Streamable HTTP / stdio transports from
// the MCP SDK are reused so existing MCP clients don't need to
// change.

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import {
  type LocalAnalyticsReport,
  countSessionsLocal,
  exportParquetLocal,
  listSessionsLocal,
  listToolCallsLocal,
  loadTranscriptLocal,
  runAnalyticsLocal,
  runQueryLocal,
  searchLocal,
} from '@c3-oss/prosa-derived-v2'
import { z } from 'zod'

const PROTOCOL_VERSION = '0.1.0'

export type V2McpServerOptions = {
  /** Absolute bundle root the tools read from. */
  bundleRoot: string
}

export type RunningV2McpStdio = {
  close(): Promise<void>
}

export type RunningV2McpHttp = {
  url: string
  close(): Promise<void>
}

/**
 * Build the McpServer instance and register every local-bundle tool.
 * Returned by the listener helpers so they share one registration
 * path. The returned server is not yet connected to a transport.
 */
function buildV2McpServer(options: V2McpServerOptions): McpServer {
  const { bundleRoot } = options
  const server = new McpServer({
    name: 'prosa-v2',
    version: PROTOCOL_VERSION,
  })

  server.registerTool(
    'prosa.sessions',
    {
      title: 'List v2 sessions',
      description:
        'Return up to `limit` sessions from the local v2 bundle, sorted by start_ts descending. Filters: source_tool, since, until. Use `count: true` to return just the row count.',
      inputSchema: {
        source_tool: z.enum(['codex', 'claude', 'cursor', 'gemini', 'hermes']).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(50),
        count: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ source_tool, since, until, limit, count }) => {
      if (count === true) {
        const result = await countSessionsLocal({
          bundleRoot,
          sourceTool: source_tool ?? null,
          sinceIso: since ?? null,
          untilIso: until ?? null,
        })
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: result.count, epoch: result.epoch }) }],
        }
      }
      const result = await listSessionsLocal({
        bundleRoot,
        sourceTool: source_tool ?? null,
        sinceIso: since ?? null,
        untilIso: until ?? null,
        limit: limit ?? 50,
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ epoch: result.epoch, rowCount: result.rows.length, rows: result.rows }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'prosa.transcript',
    {
      title: 'Render a v2 session transcript',
      description:
        'Load the session-blob pack for `session_id` from the local v2 bundle and return the messages array verbatim. Throws when the session has no pack.',
      inputSchema: {
        session_id: z.string().min(1),
        epoch: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ session_id, epoch }) => {
      const result = await loadTranscriptLocal({
        bundleRoot,
        sessionId: session_id,
        ...(epoch !== undefined ? { epoch } : {}),
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sessionId: result.sessionId,
              epoch: result.epoch,
              messageCount: result.messages.length,
              messages: result.messages,
            }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'prosa.search',
    {
      title: 'Full-text search (local NDJSON scan)',
      description:
        'Case-insensitive substring scan over `search_doc.prosa-projection.ndjson`. Returns up to `limit` matches with bounded snippets. The Tantivy-backed ranked search is remote-only for now.',
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit }) => {
      const result = await searchLocal({ bundleRoot, query, limit: limit ?? 50 })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ epoch: result.epoch, rowCount: result.rows.length, rows: result.rows }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'prosa.tool_calls',
    {
      title: 'List v2 tool calls with their results',
      description:
        'Stream `tool_call.prosa-projection.ndjson`, join the latest `tool_result` by `tool_call_id`, and apply the standard filters (session_id, tool_names, canonical_tool_types, errors_only, since, until).',
      inputSchema: {
        session_id: z.string().optional(),
        tool_names: z.array(z.string()).optional(),
        canonical_tool_types: z.array(z.string()).optional(),
        errors_only: z.boolean().optional().default(false),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ session_id, tool_names, canonical_tool_types, errors_only, since, until, limit }) => {
      const result = await listToolCallsLocal({
        bundleRoot,
        sessionId: session_id ?? null,
        ...(tool_names ? { toolNames: tool_names } : {}),
        ...(canonical_tool_types ? { canonicalToolTypes: canonical_tool_types } : {}),
        errorsOnly: errors_only ?? false,
        sinceIso: since ?? null,
        untilIso: until ?? null,
        limit: limit ?? 50,
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ epoch: result.epoch, rowCount: result.rows.length, rows: result.rows }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'prosa.analytics',
    {
      title: 'Run a v2 analytics report (DuckDB over Parquet sidecars)',
      description:
        'Resolve `report` to a canonical analytics view (sessions → session_facts, tools → tool_usage_facts, errors → error_facts, models → model_usage, projects → project_activity) and return the materialised rows.',
      inputSchema: {
        report: z.enum(['sessions', 'tools', 'errors', 'models', 'projects']),
        source_tools: z.array(z.string()).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(5000).optional().default(500),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ report, source_tools, since, until, limit }) => {
      const result = await runAnalyticsLocal({
        bundleRoot,
        report: report as LocalAnalyticsReport,
        ...(source_tools ? { sourceTools: source_tools } : {}),
        sinceIso: since ?? null,
        untilIso: until ?? null,
        limit: limit ?? 500,
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              epoch: result.epoch,
              view: result.view,
              columns: result.columns,
              rowCount: result.rows.length,
              rows: result.rows,
            }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'prosa.query',
    {
      title: 'Run an ad-hoc DuckDB query over the local v2 bundle',
      description:
        'Bind the analytics view set to the bundle and execute the operator-supplied SQL. Use the analytics tables (sessions, messages, tool_calls, tool_results, events, search_docs, projects, raw_records, source_files, turns).',
      inputSchema: {
        sql: z.string().min(1),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ sql }) => {
      const result = await runQueryLocal({ bundleRoot, sql })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              epoch: result.epoch,
              view: result.view,
              columns: result.columns,
              rowCount: result.rows.length,
              rows: result.rows,
            }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'prosa.export_parquet',
    {
      title: 'Copy the v2 Parquet sidecars to a destination directory',
      description:
        'Resolve the current epoch and copy every `<entity>.parquet` projection sibling into `out`. Returns the list of copied files.',
      inputSchema: {
        out: z.string().min(1),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ out }) => {
      const result = await exportParquetLocal({ bundleRoot, out })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              epoch: result.epoch,
              destination: result.destination,
              fileCount: result.files.length,
              files: result.files,
            }),
          },
        ],
      }
    },
  )

  return server
}

/** Listen for MCP stdio against a v2 bundle. */
export async function listenV2McpStdio(options: V2McpServerOptions): Promise<RunningV2McpStdio> {
  const server = buildV2McpServer(options)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return {
    close: async () => {
      await safeClose(server)
      await safeClose(transport)
    },
  }
}

/** Listen for MCP Streamable HTTP against a v2 bundle. */
export async function listenV2McpHttp(
  options: V2McpServerOptions & { host: string; port: number; path?: string },
): Promise<RunningV2McpHttp> {
  const mcpPath = options.path ?? '/mcp'
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>()

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, mcpPath, sessions, options).catch((err) => {
      writeError(res, err)
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, options.host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  return {
    url: `http://${options.host}:${options.port}${mcpPath}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()))
      })
      for (const { server, transport } of sessions.values()) {
        await safeClose(server)
        await safeClose(transport)
      }
      sessions.clear()
    },
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mcpPath: string,
  sessions: Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>,
  options: V2McpServerOptions,
): Promise<void> {
  const url = req.url ?? ''
  if (!url.startsWith(mcpPath)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? null
  if (req.method === 'POST') {
    const body = await readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf-8'))
    } catch {
      res.statusCode = 400
      res.end('invalid json')
      return
    }
    if (sessionId !== null && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId) as { server: McpServer; transport: StreamableHTTPServerTransport }
      await entry.transport.handleRequest(req, res, parsed)
      return
    }
    // New session.
    const server = buildV2McpServer(options)
    const id = sessionId ?? randomUUID()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport })
      },
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, parsed)
    return
  }
  if (req.method === 'DELETE' && sessionId !== null) {
    const entry = sessions.get(sessionId)
    if (entry !== undefined) {
      await safeClose(entry.server)
      await safeClose(entry.transport)
      sessions.delete(sessionId)
    }
    res.statusCode = 204
    res.end()
    return
  }
  res.statusCode = 405
  res.setHeader('allow', 'POST, DELETE')
  res.end('method not allowed')
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return
  res.statusCode = 500
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
}

async function safeClose(closeable: { close: () => unknown }): Promise<void> {
  try {
    await closeable.close()
  } catch {
    // Intentionally swallowed; we are shutting down.
  }
}

// Suppress an unused import warning when `Transport` is only used by
// type narrowing inside `safeClose`. The `Transport` interface is what
// the MCP SDK uses for stdio + HTTP transports, but TS only sees it
// through the duck-typed `safeClose` signature.
void (null as unknown as Transport)
