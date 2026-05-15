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
import { resolveReadAuthorityOrFailClosed } from '../auth/routing.js'
import { parseMcpTransport, parseSearchEngine } from '../parsers.js'

/** Create the `prosa mcp` command group for stdio and HTTP MCP servers. */
export function mcpCommand(): Command {
  const serve = new Command('serve')
    .description('Start a local MCP server over the prosa bundle.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--transport <transport>', 'MCP transport: stdio|http', 'stdio')
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', '7331')
    .option('--path <path>', 'HTTP path', '/mcp')
    .option('--search-engine <engine>', 'search engine: fts5|tantivy', 'fts5')
    .option('--local', 'read the local bundle even if this store is remote-authoritative', false)
    .action(
      async (options: {
        store: string
        host: string
        port: string
        path: string
        searchEngine: string
        transport: string
        local: boolean
      }) => {
        const storePath = path.resolve(options.store)
        await resolveReadAuthorityOrFailClosed({
          commandName: 'prosa mcp serve',
          storePath,
          forceLocal: options.local,
          remoteSupported: false,
        })
        const bundle = await openOrInitBundle(storePath)
        try {
          const transport = parseMcpTransport(options.transport)
          const searchEngine = parseSearchEngine(options.searchEngine)
          if (transport === 'http') {
            const port = Number.parseInt(options.port, 10)
            if (!Number.isFinite(port) || port <= 0) {
              throw new Error(`invalid port: ${options.port}`)
            }
            const server = await listenMcpServer(bundle, {
              host: options.host,
              port,
              path: options.path,
              searchEngine,
              storePath,
            })

            process.stdout.write(`prosa mcp server listening at ${server.url}\n`)
            process.stdout.write('press Ctrl+C to stop\n')
            registerShutdown(server.close, bundle)
            return
          }

          const server = await listenMcpStdioServer(bundle, { searchEngine, storePath })
          registerShutdown(server.close, bundle)
        } catch (error) {
          closeBundle(bundle)
          throw error
        }
      },
    )

  return new Command('mcp').description('MCP server commands.').addCommand(serve)
}

/** Close the MCP server and bundle once when the process receives a termination signal. */
function registerShutdown(closeServer: () => Promise<void>, bundle: Bundle): void {
  const shutdown = async (): Promise<void> => {
    await closeServer()
    closeBundle(bundle)
    process.exit(0)
  }
  process.once('SIGINT', () => {
    void shutdown()
  })
  process.once('SIGTERM', () => {
    void shutdown()
  })
}
