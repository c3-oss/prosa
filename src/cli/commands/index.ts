import { Command } from 'commander';
import { defaultBundlePath } from '../../core/bundle.js';
import {
  getSearchIndexStatuses,
  rebuildFts5Index,
  rebuildTantivyIndex,
} from '../../services/indexing.js';
import { withBundle } from '../bundle.js';
import { parseOutputFormat, printRows } from '../output.js';

export function indexCommand(): Command {
  const fts5 = new Command('fts5')
    .description('Rebuild the SQLite FTS5 index from search_docs.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (options: { store: string }) => {
      await withBundle(options.store, (bundle) => {
        printIndexStatus(rebuildFts5Index(bundle));
      });
    });

  const tantivy = new Command('tantivy')
    .description('Rebuild the Tantivy sidecar index from search_docs.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (options: { store: string }) => {
      await withBundle(options.store, async (bundle) => {
        printIndexStatus(await rebuildTantivyIndex(bundle));
      });
    });

  const status = new Command('status')
    .description('Show derived search index status.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(async (options: { store: string; outputFormat: string }) => {
      const format = parseOutputFormat(options.outputFormat, 'table');
      await withBundle(options.store, (bundle) => {
        const rows = getSearchIndexStatuses(bundle);
        printRows(rows as unknown as Record<string, unknown>[], {
          format,
          columns: [
            'engine',
            'status',
            'source_doc_count',
            'indexed_doc_count',
            'updated_at',
            'error_message',
          ],
        });
      });
    });

  return new Command('index')
    .description('Build or inspect derived search indexes.')
    .addCommand(fts5)
    .addCommand(tantivy)
    .addCommand(status);
}

function printIndexStatus(status: {
  engine: string;
  status: string;
  source_doc_count: number;
  indexed_doc_count: number;
}): void {
  process.stdout.write(
    `${status.engine} index: ${status.status}\n` +
      `  source_docs=${status.source_doc_count} indexed_docs=${status.indexed_doc_count}\n`,
  );
}
