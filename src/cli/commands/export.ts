import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import { exportSessionMarkdown } from '../../services/export/markdown.js';

export function exportCommand(): Command {
  const session = new Command('session')
    .description('Export a single session to a human-readable format.')
    .argument('<session-id>', 'prosa session_id')
    .requiredOption('--format <fmt>', 'currently only "markdown" is supported')
    .option('--out <path>', 'write to file instead of stdout')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (sessionId: string, options: { format: string; out?: string; store: string }) => {
      if (options.format !== 'markdown') {
        throw new Error(`unsupported format: ${options.format} (try --format markdown)`);
      }
      const bundle = await openBundle(path.resolve(options.store));
      try {
        const markdown = await exportSessionMarkdown(bundle, sessionId);
        if (options.out) {
          await writeFile(path.resolve(options.out), markdown, 'utf8');
          process.stdout.write(`wrote ${path.resolve(options.out)}\n`);
        } else {
          process.stdout.write(markdown);
        }
      } finally {
        closeBundle(bundle);
      }
    });

  return new Command('export')
    .description('Export sessions / search excerpts to readable formats.')
    .addCommand(session);
}
