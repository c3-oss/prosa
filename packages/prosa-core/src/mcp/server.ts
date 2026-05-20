import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Bundle } from '../core/bundle.js'
import { getErrorMessage } from '../core/errors.js'
import { PROSA_PARSER_VERSION } from '../core/version.js'
import type { SearchEngine } from '../services/indexing.js'
import { PROSA_MCP_INSTRUCTIONS } from './guidance.js'
import { type RefreshAuthorityResult, registerProsaTools } from './tools.js'

interface SessionEntry {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

/** HTTP transport options for exposing a prosa bundle as an MCP server. */
export interface McpServerOptions {
  /** Hostname or IP address to bind. */
  host: string
  /** TCP port to bind. */
  port: number
  /** HTTP path that receives MCP Streamable HTTP requests. Defaults to `/mcp`. */
  path?: string
  /** Default search engine passed to MCP search tools. */
  searchEngine?: SearchEngine
  /** Bundle path reopened by long-lived tool handlers. Defaults to `bundle.path`. */
  storePath?: string
  /**
   * CQ-149: when provided, the server registers a
   * `prosa.refresh_authority` MCP tool that invokes this callback.
   * Local-mode callers should leave this undefined so the tool
   * stays absent.
   */
  onRefreshAuthority?: () => Promise<RefreshAuthorityResult>
}

/** Handle returned by the HTTP MCP server listener. */
export interface RunningServer {
  /** Full URL clients should use for Streamable HTTP requests. */
  url: string
  /** Stop the HTTP listener and close all active MCP sessions. */
  close(): Promise<void>
}

/** Handle returned by the stdio MCP server listener. */
export interface RunningStdioServer {
  /** Close the MCP server and stdio transport. */
  close(): Promise<void>
}

/** Stdio transport options for exposing a prosa bundle as an MCP server. */
export interface McpStdioServerOptions {
  /** Default search engine passed to MCP search tools. */
  searchEngine?: SearchEngine
  /** Bundle path reopened by long-lived tool handlers. Defaults to `bundle.path`. */
  storePath?: string
  /** CQ-149: register `prosa.refresh_authority` when defined. */
  onRefreshAuthority?: () => Promise<RefreshAuthorityResult>
}

/** Start a stdio MCP server backed by an already-open prosa bundle. */
export async function listenMcpStdioServer(
  bundle: Bundle,
  options: McpStdioServerOptions = {},
): Promise<RunningStdioServer> {
  const server = createMcpServer(bundle, options.searchEngine ?? 'fts5', options.storePath, options.onRefreshAuthority)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  return {
    close: async () => {
      await safeClose(server)
      await safeClose(transport)
    },
  }
}

/**
 * Bind an HTTP MCP server on `host:port` backed by `bundle`. Implements the
 * Streamable HTTP transport with stateful sessions (one McpServer per
 * `MCP-Session-Id`).
 *
 * - POST /mcp   — JSON-RPC requests; opens a session if `MCP-Session-Id` is missing
 * - DELETE /mcp — close an existing session by header
 * - GET /mcp    — 405 (we don't expose server-initiated SSE streams)
 */
export async function listenMcpServer(bundle: Bundle, options: McpServerOptions): Promise<RunningServer> {
  const mcpPath = options.path ?? '/mcp'
  const sessions = new Map<string, SessionEntry>()

  const searchEngine = options.searchEngine ?? 'fts5'
  const storePath = options.storePath ?? bundle.path
  const onRefreshAuthority = options.onRefreshAuthority

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, mcpPath, sessions, bundle, searchEngine, storePath, onRefreshAuthority).catch(
      (error: unknown) => {
        writeError(res, error)
      },
    )
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
      for (const entry of sessions.values()) {
        await safeClose(entry.server)
        await safeClose(entry.transport)
      }
      sessions.clear()
    },
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mcpPath: string,
  sessions: Map<string, SessionEntry>,
  bundle: Bundle,
  searchEngine: SearchEngine,
  storePath: string,
  onRefreshAuthority?: () => Promise<RefreshAuthorityResult>,
): Promise<void> {
  // Keep HTTP routing deliberately small: this listener owns exactly one MCP
  // endpoint and delegates protocol details to StreamableHTTPServerTransport.
  if (!req.url || !req.url.startsWith(mcpPath)) {
    res.writeHead(404).end()
    return
  }
  const method = req.method ?? 'GET'

  if (method === 'GET') {
    // Match the Sourcebot reference: we don't initiate SSE streams from the
    // server side, so GET is rejected per the MCP Streamable HTTP spec.
    res.writeHead(405, { Allow: 'POST, DELETE' }).end()
    return
  }
  if (method !== 'POST' && method !== 'DELETE') {
    res.writeHead(405, { Allow: 'POST, DELETE' }).end()
    return
  }

  const headerSessionId = req.headers['mcp-session-id']
  const sessionId =
    typeof headerSessionId === 'string'
      ? headerSessionId
      : Array.isArray(headerSessionId)
        ? headerSessionId[0]
        : undefined

  let entry: SessionEntry | undefined = sessionId ? sessions.get(sessionId) : undefined

  if (!entry) {
    if (method === 'DELETE') {
      res.writeHead(404).end()
      return
    }
    entry = await openSession(bundle, sessions, searchEngine, storePath, onRefreshAuthority)
  }

  const bodyText = await readBody(req)
  const body = bodyText.length > 0 ? safeJsonParse(bodyText) : undefined
  await entry.transport.handleRequest(req, res, body)
}

/** Create and connect a new MCP session, then let the transport register its generated id. */
async function openSession(
  bundle: Bundle,
  store: Map<string, SessionEntry>,
  searchEngine: SearchEngine,
  storePath: string,
  onRefreshAuthority?: () => Promise<RefreshAuthorityResult>,
): Promise<SessionEntry> {
  // We need to assemble server + transport together because the transport's
  // `onsessioninitialized` callback wants to register both into the map.
  const server = createMcpServer(bundle, searchEngine, storePath, onRefreshAuthority)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => {
      store.set(id, { server, transport })
    },
    onsessionclosed: async (id: string) => {
      const e = store.get(id)
      if (e) {
        await safeClose(e.server)
        await safeClose(e.transport)
        store.delete(id)
      }
    },
  })

  await server.connect(transport)
  return { server, transport }
}

/** Build a per-session MCP server instance with prosa instructions and tools attached. */
function createMcpServer(
  bundle: Bundle,
  searchEngine: SearchEngine,
  storePath?: string,
  onRefreshAuthority?: () => Promise<RefreshAuthorityResult>,
): McpServer {
  const server = new McpServer(
    {
      name: 'prosa',
      version: PROSA_PARSER_VERSION,
    },
    { instructions: PROSA_MCP_INSTRUCTIONS },
  )
  registerProsaTools(server, bundle, { ensureStore: true, searchEngine, storePath, onRefreshAuthority })
  return server
}

/** Read a request body once so the MCP transport can consume a parsed JSON-RPC payload. */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Parse optional JSON request bodies; invalid or empty bodies are passed through as undefined. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Close transports and servers defensively during shutdown. */
async function safeClose(o: { close: () => Promise<void> | void } | Transport): Promise<void> {
  try {
    await o.close()
  } catch {
    /* ignore */
  }
}

/** Write a JSON-RPC internal error response when request handling fails before transport dispatch. */
function writeError(res: ServerResponse, error: unknown): void {
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
  }
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: getErrorMessage(error) },
      id: null,
    }),
  )
}
