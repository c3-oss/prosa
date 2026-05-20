// Lane 7 — `prosa mcp serve --authority {auto|local|remote} [--refresh]`.
//
// Wraps the existing local-bundle MCP server with the v2 authority
// pinning policy from L11:
//   - `auto`: try the v2 authority cache for a recorded promotion;
//             when the local bundle root matches the cached receipt,
//             resolve to local; otherwise prefer remote and surface
//             the pinned receipt id to stderr.
//   - `local`: skip authority resolution; serve the local bundle.
//   - `remote`: require a recorded v2 promotion + cached/refreshed
//               authority; refuse to start otherwise.
//
// The actual `prosa.refresh_authority` MCP tool registration is
// tracked as a follow-up CQ (CQ-149); registering it inside the
// running McpServer requires extending prosa-core's tool factory
// to accept an `onRefreshAuthority` callback. The pinned context
// surfaced here lets Lane 8 reason about audit drift without a
// second tool-registration pass.

import path from 'node:path'
import {
  type Bundle,
  closeBundle,
  defaultBundlePath,
  listenMcpServer,
  listenMcpStdioServer,
  openOrInitBundle,
} from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { CliUserError } from '../../errors.js'
import { parseMcpTransport, parseSearchEngine } from '../../parsers.js'
import { type AuthorityMode, type V2ReadContext, resolveV2ReadContext } from '../read-context.js'

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
        commandName: 'prosa mcp serve',
        storePath,
        authorityMode: options.authority,
        forceRefresh: options.refresh,
        offline: options.offline,
        configPath: options.config,
      })

      logPinnedAuthority(ctx)

      const bundle = await openOrInitBundle(storePath)
      try {
        const transport = parseMcpTransport(options.transport)
        const searchEngine = parseSearchEngine(options.searchEngine)
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
          })
          process.stdout.write(`prosa mcp v2 server listening at ${httpServer.url}\n`)
          process.stdout.write('press Ctrl+C to stop\n')
          registerShutdown(httpServer.close, bundle)
          return
        }
        const stdioServer = await listenMcpStdioServer(bundle, { searchEngine, storePath })
        registerShutdown(stdioServer.close, bundle)
      } catch (error) {
        closeBundle(bundle)
        throw error
      }
    })
}

function logPinnedAuthority(ctx: V2ReadContext): void {
  if (ctx.kind === 'local') {
    process.stderr.write('prosa mcp serve: authority pinned to local bundle.\n')
    return
  }
  process.stderr.write(
    `prosa mcp serve: authority pinned to ${ctx.entry.url} (storeId=${ctx.storeId} receiptId=${ctx.authority.receiptId} auditStatus=${ctx.authority.auditStatus}).\nCQ-149: the \`prosa.refresh_authority\` MCP tool is not yet exposed; restart the server to refresh.\n`,
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
 * Module-level export for the `mcp` command group used during
 * incremental adoption. The legacy `mcp serve` command stays
 * registered alongside until Lane 10.
 */
export function mcpV2Command(): Command {
  return new Command('mcp-v2').description('MCP server commands (v2 authority-aware).').addCommand(mcpServeV2Command())
}
