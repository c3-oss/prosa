import path from 'node:path';
import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import {
  getSearchIndexStatuses,
  rebuildFts5Index,
  rebuildTantivyIndex,
} from '../../services/indexing.js';
import { parseOutputFormat, printRows } from '../output.js';

export function indexCommand(): Command {
  const fts5 = new Command('fts5')
    .description('Rebuild the SQLite FTS5 index from search_docs.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (options: { store: string }) => {
      const bundle = await openBundle(path.resolve(options.store));
      try {
        const status = rebuildFts5Index(bundle);
        printIndexStatus(status);
      } finally {
        closeBundle(bundle);
      }
    });

  const tantivy = new Command('tantivy')
    .description('Rebuild the Tantivy sidecar index from search_docs.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (options: { store: string }) => {
      const bundle = await openBundle(path.resolve(options.store));
      try {
        const status = await rebuildTantivyIndex(bundle);
        printIndexStatus(status);
      } finally {
        closeBundle(bundle);
      }
    });

  const status = new Command('status')
    .description('Show derived search index status.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(async (options: { store: string; outputFormat: string }) => {
      const format = parseOutputFormat(options.outputFormat, 'table');
      const bundle = await openBundle(path.resolve(options.store));
      try {
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
      } finally {
        closeBundle(bundle);
      }
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
