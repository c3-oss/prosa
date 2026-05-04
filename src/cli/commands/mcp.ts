import path from 'node:path';
import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import { listenMcpServer } from '../../mcp/server.js';
import type { SearchEngine } from '../../services/indexing.js';

export function mcpCommand(): Command {
  const serve = new Command('serve')
    .description('Start a local MCP server (HTTP streamable) over the prosa bundle.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', '7331')
    .option('--path <path>', 'HTTP path', '/mcp')
    .option('--search-engine <engine>', 'search engine: fts5|tantivy', 'fts5')
    .action(
      async (options: {
        store: string;
        host: string;
        port: string;
        path: string;
        searchEngine: string;
      }) => {
        const bundle = await openBundle(path.resolve(options.store));
        const port = Number.parseInt(options.port, 10);
        if (!Number.isFinite(port) || port <= 0) {
          throw new Error(`invalid port: ${options.port}`);
        }
        const searchEngine = parseSearchEngine(options.searchEngine);
        const server = await listenMcpServer(bundle, {
          host: options.host,
          port,
          path: options.path,
          searchEngine,
        });

        process.stdout.write(`prosa mcp server listening at ${server.url}\n`);
        process.stdout.write('press Ctrl+C to stop\n');

        const shutdown = async (): Promise<void> => {
          await server.close();
          closeBundle(bundle);
          process.exit(0);
        };
        process.once('SIGINT', () => {
          void shutdown();
        });
        process.once('SIGTERM', () => {
          void shutdown();
        });
      },
    );

  return new Command('mcp').description('MCP server commands.').addCommand(serve);
}

function parseSearchEngine(value: string): SearchEngine {
  if (value === 'fts5' || value === 'tantivy') return value;
  throw new Error(`invalid --search-engine: ${value} (expected fts5 or tantivy)`);
}
