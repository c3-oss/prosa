import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Bundle } from '../core/bundle.js';
import { getErrorMessage } from '../core/errors.js';
import { PROSA_PARSER_VERSION } from '../core/version.js';
import type { SearchEngine } from '../services/indexing.js';
import { PROSA_MCP_INSTRUCTIONS } from './guidance.js';
import { registerProsaTools } from './tools.js';

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface McpServerOptions {
  host: string;
  port: number;
  path?: string;
  searchEngine?: SearchEngine;
  storePath?: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export interface RunningStdioServer {
  close(): Promise<void>;
}

export interface McpStdioServerOptions {
  searchEngine?: SearchEngine;
  storePath?: string;
}

export async function listenMcpStdioServer(
  bundle: Bundle,
  options: McpStdioServerOptions = {},
): Promise<RunningStdioServer> {
  const server = createMcpServer(bundle, options.searchEngine ?? 'fts5', options.storePath);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    close: async () => {
      await safeClose(server);
      await safeClose(transport);
    },
  };
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
export async function listenMcpServer(
  bundle: Bundle,
  options: McpServerOptions,
): Promise<RunningServer> {
  const mcpPath = options.path ?? '/mcp';
  const sessions = new Map<string, SessionEntry>();

  const searchEngine = options.searchEngine ?? 'fts5';
  const storePath = options.storePath ?? bundle.path;

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, mcpPath, sessions, bundle, searchEngine, storePath).catch(
      (error: unknown) => {
        writeError(res, error);
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  return {
    url: `http://${options.host}:${options.port}${mcpPath}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      for (const entry of sessions.values()) {
        await safeClose(entry.server);
        await safeClose(entry.transport);
      }
      sessions.clear();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mcpPath: string,
  sessions: Map<string, SessionEntry>,
  bundle: Bundle,
  searchEngine: SearchEngine,
  storePath: string,
): Promise<void> {
  if (!req.url || !req.url.startsWith(mcpPath)) {
    res.writeHead(404).end();
    return;
  }
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    // Match the Sourcebot reference: we don't initiate SSE streams from the
    // server side, so GET is rejected per the MCP Streamable HTTP spec.
    res.writeHead(405, { Allow: 'POST, DELETE' }).end();
    return;
  }
  if (method !== 'POST' && method !== 'DELETE') {
    res.writeHead(405, { Allow: 'POST, DELETE' }).end();
    return;
  }

  const headerSessionId = req.headers['mcp-session-id'];
  const sessionId =
    typeof headerSessionId === 'string'
      ? headerSessionId
      : Array.isArray(headerSessionId)
        ? headerSessionId[0]
        : undefined;

  let entry: SessionEntry | undefined = sessionId ? sessions.get(sessionId) : undefined;

  if (!entry) {
    if (method === 'DELETE') {
      res.writeHead(404).end();
      return;
    }
    entry = await openSession(bundle, sessions, searchEngine, storePath);
  }

  const bodyText = await readBody(req);
  const body = bodyText.length > 0 ? safeJsonParse(bodyText) : undefined;
  await entry.transport.handleRequest(req, res, body);
}

async function openSession(
  bundle: Bundle,
  store: Map<string, SessionEntry>,
  searchEngine: SearchEngine,
  storePath: string,
): Promise<SessionEntry> {
  // We need to assemble server + transport together because the transport's
  // `onsessioninitialized` callback wants to register both into the map.
  const server = createMcpServer(bundle, searchEngine, storePath);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => {
      store.set(id, { server, transport });
    },
    onsessionclosed: async (id: string) => {
      const e = store.get(id);
      if (e) {
        await safeClose(e.server);
        await safeClose(e.transport);
        store.delete(id);
      }
    },
  });

  await server.connect(transport);
  return { server, transport };
}

function createMcpServer(
  bundle: Bundle,
  searchEngine: SearchEngine,
  storePath?: string,
): McpServer {
  const server = new McpServer(
    {
      name: 'prosa',
      version: PROSA_PARSER_VERSION,
    },
    { instructions: PROSA_MCP_INSTRUCTIONS },
  );
  registerProsaTools(server, bundle, { ensureStore: true, searchEngine, storePath });
  return server;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function safeClose(o: { close: () => Promise<void> | void } | Transport): Promise<void> {
  try {
    await o.close();
  } catch {
    /* ignore */
  }
}

function writeError(res: ServerResponse, error: unknown): void {
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
  }
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: getErrorMessage(error) },
      id: null,
    }),
  );
}
