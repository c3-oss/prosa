// Lane 7 — `prosa v2 mcp serve --authority {auto|local|remote} [--refresh]`.
//
// Wraps the prosa-core MCP server with the v2 authority pinning
// policy from L11:
//   - `auto`: try the v2 authority cache for a recorded promotion;
//             otherwise serve the local bundle.
//   - `local`: skip authority resolution; serve the local bundle.
//             The `prosa.refresh_authority` tool is NOT registered.
//   - `remote`: require a recorded v2 promotion + cached/refreshed
//               authority; refuse to start otherwise.
//
// CQ-149 close: the server registers `prosa.refresh_authority` when
// the resolved context is remote. The tool refreshes via the
// shared authority resolver and updates the pinned receipt id in
// place. Local-mode servers never expose the tool.

import path from 'node:path'
import {
  type Bundle,
  closeBundle,
  defaultBundlePath,
  listenMcpServer,
  listenMcpStdioServer,
  openOrInitBundle,
} from '@c3-oss/prosa-core'
import type { RefreshAuthorityResult } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { CliUserError } from '../../errors.js'
import { parseMcpTransport, parseSearchEngine } from '../../parsers.js'
import { defaultV2AuthorityDir, refreshAuthorityNow } from '../authority/index.js'
import { listenV2McpHttp, listenV2McpStdio } from '../mcp/v2-server.js'
import {
  type AuthorityMode,
  type V2ReadContext,
  type V2ReadContextRemote,
  resolveV2ReadContext,
} from '../read-context.js'

type McpServeV2Options = {
  store: string
  authority: AuthorityMode
  refresh: boolean
  offline: boolean
  transport: string
  host: string
  port: string
  path: string
  searchEngine: string
  server?: string
  config?: string
}

function parseAuthority(value: string): AuthorityMode {
  if (value === 'auto' || value === 'local' || value === 'remote') return value
  throw new CliUserError(`invalid --authority: ${value} (expected auto|local|remote)`)
}

export function mcpServeV2Command(): Command {
  return new Command('serve')
    .description('Start an MCP server over the prosa v2 bundle with pinned authority.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--authority <mode>', 'authority mode: auto|local|remote', parseAuthority, 'auto' as AuthorityMode)
    .option('--refresh', 'force a remote authority refresh at startup', false)
    .option('--offline', 'pin to the cached authority; never hit the network', false)
    .option('--transport <transport>', 'MCP transport: stdio|http', 'stdio')
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', '7331')
    .option('--path <path>', 'HTTP path', '/mcp')
    .option('--search-engine <engine>', 'search engine: fts5|tantivy', 'fts5')
    .option('--server <url>', 'override server URL for the active config')
    .option('--config <path>', 'override CLI config path')
    .action(async (options: McpServeV2Options) => {
      const storePath = path.resolve(options.store)
      const ctx = await resolveV2ReadContext({
        commandName: 'prosa v2 mcp serve',
        storePath,
        authorityMode: options.authority,
        forceRefresh: options.refresh,
        offline: options.offline,
        configPath: options.config,
      })

      logPinnedAuthority(ctx)

      const transport = parseMcpTransport(options.transport)

      // Local mode: the v2 MCP server reads straight from the local
      // bundle's NDJSON / Parquet / session-blob artifacts via the
      // `local-reads/*` service. No v1 SQLite handle involved.
      if (ctx.kind === 'local') {
        if (transport === 'http') {
          const port = Number.parseInt(options.port, 10)
          if (!Number.isFinite(port) || port <= 0) {
            throw new CliUserError(`invalid port: ${options.port}`)
          }
          const httpServer = await listenV2McpHttp({
            bundleRoot: storePath,
            host: options.host,
            port,
            path: options.path,
          })
          process.stdout.write(`prosa v2 mcp (local) listening at ${httpServer.url}\n`)
          process.stdout.write('press Ctrl+C to stop\n')
          registerV2Shutdown(httpServer.close)
          return
        }
        const stdioServer = await listenV2McpStdio({ bundleRoot: storePath })
        registerV2Shutdown(stdioServer.close)
        return
      }

      // Remote mode keeps the prosa-core MCP server for now; the
      // tools still talk to the v1 bundle handle. A v2 remote-backed
      // MCP server is tracked as follow-up work — the local-reads
      // path above already covers the common stress-test recipe.
      const onRefreshAuthority = makeRefreshCallback(ctx)
      const searchEngine = parseSearchEngine(options.searchEngine)
      const bundle = await openOrInitBundle(storePath)
      try {
        if (transport === 'http') {
          const port = Number.parseInt(options.port, 10)
          if (!Number.isFinite(port) || port <= 0) {
            throw new CliUserError(`invalid port: ${options.port}`)
          }
          const httpServer = await listenMcpServer(bundle, {
            host: options.host,
            port,
            path: options.path,
            searchEngine,
            storePath,
            onRefreshAuthority,
          })
          process.stdout.write(`prosa v2 mcp (remote) listening at ${httpServer.url}\n`)
          process.stdout.write('press Ctrl+C to stop\n')
          registerShutdown(httpServer.close, bundle)
          return
        }
        const stdioServer = await listenMcpStdioServer(bundle, { searchEngine, storePath, onRefreshAuthority })
        registerShutdown(stdioServer.close, bundle)
      } catch (error) {
        closeBundle(bundle)
        throw error
      }
    })
}

function registerV2Shutdown(closeServer: () => Promise<void>): void {
  const shutdown = async (): Promise<void> => {
    await closeServer()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

/**
 * CQ-149 — build the `prosa.refresh_authority` callback. It refreshes
 * the v2 authority via the shared resolver, mutates the pinned
 * read-context receipt id, and returns the receipt id the MCP
 * server is now bound to. Errors propagate to the caller as a
 * tool-level error (the prosa-core registration catches them).
 */
function makeRefreshCallback(ctx: V2ReadContextRemote): () => Promise<RefreshAuthorityResult> {
  return async () => {
    if (!ctx.entry.token) {
      throw new Error('MCP server has no auth token; restart `prosa auth login` and `prosa v2 mcp serve`.')
    }
    const refreshed = await refreshAuthorityNow({
      configDir: defaultV2AuthorityDir(),
      serverUrl: ctx.entry.url,
      tenantId: ctx.client.tenantId,
      storeId: ctx.storeId,
      token: ctx.entry.token,
      knownReceiptId: ctx.authority.receiptId,
    })
    // Mutate the captured context in place so subsequent
    // refresh_authority calls compare against the latest receipt id.
    ctx.authority.receiptId = refreshed.receiptId
    ctx.authority.receipt = refreshed.receipt
    ctx.authority.auditStatus = refreshed.auditStatus
    ctx.authority.checkedAt = refreshed.checkedAt
    ctx.authority.expiresAt = refreshed.expiresAt
    return {
      receiptId: refreshed.receiptId,
      auditStatus: refreshed.auditStatus,
      refreshedAt: refreshed.checkedAt,
    }
  }
}

function logPinnedAuthority(ctx: V2ReadContext): void {
  if (ctx.kind === 'local') {
    process.stderr.write(
      'prosa v2 mcp serve: authority pinned to local bundle. The `prosa.refresh_authority` MCP tool is not registered in --authority local.\n',
    )
    return
  }
  process.stderr.write(
    `prosa v2 mcp serve: authority pinned to ${ctx.entry.url} (storeId=${ctx.storeId} receiptId=${ctx.authority.receiptId} auditStatus=${ctx.authority.auditStatus}). The \`prosa.refresh_authority\` MCP tool is registered; callers invoke it to refresh in place.\n`,
  )
}

function registerShutdown(closeServer: () => Promise<void>, bundle: Bundle): void {
  const shutdown = async (): Promise<void> => {
    await closeServer()
    closeBundle(bundle)
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

/**
 * Module-level export for the `mcp` command group used inside the
 * `prosa v2` namespace. The v1 `prosa v1 mcp serve` command stays
 * registered alongside until Lane 10.
 */
export function mcpV2Command(): Command {
  return new Command('mcp').description('MCP server commands (v2 authority-aware).').addCommand(mcpServeV2Command())
}
