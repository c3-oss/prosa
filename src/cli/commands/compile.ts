import path from 'node:path';
import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import type { ImportCounts } from '../../core/ingest/batch.js';
import { compileClaude } from '../../importers/claude/index.js';
import { compileCodex } from '../../importers/codex/index.js';
import { compileCursor } from '../../importers/cursor/index.js';
import { compileGemini } from '../../importers/gemini/index.js';

export function compileCommand(): Command {
  return new Command('compile')
    .description('Import session histories from one or more agent CLIs into the bundle.')
    .option('--codex <path>', 'root of Codex CLI sessions (e.g. ~/.codex/sessions)')
    .option('--claude <path>', 'root of Claude Code projects (e.g. ~/.claude/projects)')
    .option('--gemini <path>', 'root of Gemini CLI tmp dir (e.g. ~/.gemini/tmp)')
    .option('--cursor <path>', 'root of Cursor agent stores (e.g. ~/.cursor/chats)')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(
      async (options: {
        codex?: string;
        claude?: string;
        gemini?: string;
        cursor?: string;
        store: string;
      }) => {
        if (!options.codex && !options.claude && !options.gemini && !options.cursor) {
          process.stderr.write(
            'no source specified — pass at least one of --codex / --claude / --gemini / --cursor\n',
          );
          process.exit(2);
        }

        const bundle = await openBundle(path.resolve(options.store));
        try {
          if (options.codex) {
            const r = await compileCodex(bundle, path.resolve(options.codex));
            printCounts('codex', r.batch.batch_id, r.counts);
          }
          if (options.claude) {
            const r = await compileClaude(bundle, path.resolve(options.claude));
            printCounts('claude', r.batch.batch_id, r.counts);
          }
          if (options.gemini) {
            const r = await compileGemini(bundle, path.resolve(options.gemini));
            printCounts('gemini', r.batch.batch_id, r.counts);
          }
          if (options.cursor) {
            const r = await compileCursor(bundle, path.resolve(options.cursor));
            printCounts('cursor', r.batch.batch_id, r.counts);
          }
        } finally {
          closeBundle(bundle);
        }
      },
    );
}

function printCounts(label: string, batchId: string, c: ImportCounts): void {
  process.stdout.write(
    `${label} import: batch=${batchId}\n` +
      `  source_files seen=${c.source_files_seen} imported=${c.source_files_imported} skipped=${c.source_files_skipped}\n` +
      `  sessions=${c.sessions} turns=${c.turns} messages=${c.messages} blocks=${c.content_blocks}\n` +
      `  events=${c.events} tool_calls=${c.tool_calls} tool_results=${c.tool_results}\n` +
      `  artifacts=${c.artifacts} edges=${c.edges} errors=${c.errors}\n`,
  );
}
