import { Command } from 'commander';
import { defaultBundlePath } from '../../core/bundle.js';
import type { SearchEngine } from '../../services/indexing.js';
import { searchFullText } from '../../services/search.js';
import { withBundle } from '../bundle.js';
import { parseOutputFormat, printRows } from '../output.js';

export function searchCommand(): Command {
  return new Command('search')
    .description('Full-text search across messages, tool calls and tool outputs.')
    .argument('<query>', 'FTS5 query string (supports MATCH syntax)')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--limit <n>', 'maximum hits', '50')
    .option('--engine <engine>', 'search engine: fts5|tantivy', 'fts5')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(
      async (
        query: string,
        options: { store: string; limit: string; engine: string; outputFormat: string },
      ) => {
        const engine = parseSearchEngine(options.engine);
        const format = parseOutputFormat(options.outputFormat, 'table');
        await withBundle(options.store, (bundle) => {
          const hits = searchFullText(bundle, {
            query,
            limit: Number.parseInt(options.limit, 10),
            engine,
          });
          printRows(hits as unknown as Record<string, unknown>[], {
            format,
            columns: ['timestamp', 'role', 'tool_name', 'session_id', 'snippet'],
            meta: { query, engine, count: hits.length },
          });
        });
      },
    );
}

function parseSearchEngine(value: string): SearchEngine {
  if (value === 'fts5' || value === 'tantivy') return value;
  throw new Error(`invalid --engine: ${value} (expected fts5 or tantivy)`);
}
