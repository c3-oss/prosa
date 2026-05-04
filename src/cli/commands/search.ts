import path from 'node:path';
import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import { searchFullText } from '../../services/search.js';
import { parseOutputFormat, printRows } from '../output.js';

export function searchCommand(): Command {
  return new Command('search')
    .description('Full-text search across messages, tool calls and tool outputs.')
    .argument('<query>', 'FTS5 query string (supports MATCH syntax)')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--limit <n>', 'maximum hits', '50')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(
      async (query: string, options: { store: string; limit: string; outputFormat: string }) => {
        const format = parseOutputFormat(options.outputFormat, 'table');
        const bundle = await openBundle(path.resolve(options.store));
        try {
          const hits = searchFullText(bundle, {
            query,
            limit: Number.parseInt(options.limit, 10),
          });
          printRows(hits as unknown as Record<string, unknown>[], {
            format,
            columns: ['timestamp', 'role', 'tool_name', 'session_id', 'snippet'],
            meta: { query, count: hits.length },
          });
        } finally {
          closeBundle(bundle);
        }
      },
    );
}
