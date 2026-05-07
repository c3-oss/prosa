import { Command } from 'commander';
import { defaultBundlePath } from '../../core/bundle.js';
import type { SourceTool } from '../../core/domain/types.js';
import { countSessions, listSessions } from '../../services/sessions.js';
import { withBundle } from '../bundle.js';
import { parseOutputFormat, printRows } from '../output.js';

export function sessionsCommand(): Command {
  const command = new Command('sessions')
    .description('List sessions in the bundle, with filters.')
    .enablePositionalOptions()
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini')
    .option('--since <iso>', 'sessions starting on/after this ISO timestamp')
    .option('--until <iso>', 'sessions starting before this ISO timestamp')
    .option('--limit <n>', 'maximum rows', '50')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(
      async (options: {
        store: string;
        source?: string;
        since?: string;
        until?: string;
        limit: string;
        outputFormat: string;
      }) => {
        const format = parseOutputFormat(options.outputFormat, 'table');
        await withBundle(options.store, (bundle) => {
          const rows = listSessions(bundle, {
            sourceTool: options.source as SourceTool | undefined,
            sinceIso: options.since,
            untilIso: options.until,
            limit: Number.parseInt(options.limit, 10),
          });

          printRows(rows as unknown as Record<string, unknown>[], {
            format,
            columns: [
              'start_ts',
              'source_tool',
              'session_id',
              'model_last',
              'message_count',
              'tool_call_count',
              'cwd_initial',
              'title',
            ],
          });
        });
      },
    );

  command.addCommand(
    new Command('count')
      .description('Count sessions in the bundle, with filters.')
      .option('--store <path>', 'bundle directory', defaultBundlePath())
      .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini')
      .option('--since <iso>', 'sessions starting on/after this ISO timestamp')
      .option('--until <iso>', 'sessions starting before this ISO timestamp')
      .action(
        async (options: {
          store: string;
          source?: string;
          since?: string;
          until?: string;
        }) => {
          await withBundle(options.store, (bundle) => {
            const count = countSessions(bundle, {
              sourceTool: options.source as SourceTool | undefined,
              sinceIso: options.since,
              untilIso: options.until,
            });
            process.stdout.write(`${count}\n`);
          });
        },
      ),
  );

  return command;
}
