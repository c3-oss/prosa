#!/usr/bin/env node
import { Command } from 'commander';
import { PROSA_PARSER_VERSION } from '../core/version.js';
import { compileAllCommand, compileCommand } from './commands/compile.js';
import { exportCommand } from './commands/export.js';
import { indexCommand } from './commands/index.js';
import { initCommand } from './commands/init.js';
import { mcpCommand } from './commands/mcp.js';
import { queryCommand } from './commands/query.js';
import { searchCommand } from './commands/search.js';
import { sessionsCommand } from './commands/sessions.js';
import { tuiCommand } from './commands/tui.js';

export async function runCli(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name('prosa')
    .enablePositionalOptions()
    .description(
      'Compile, search and export local agent session histories\n' +
        '(Cursor, Codex CLI, Claude Code, Gemini CLI) into one canonical store.',
    )
    .version(PROSA_PARSER_VERSION, '-v, --version');

  program.addCommand(initCommand());
  program.addCommand(compileCommand());
  program.addCommand(compileAllCommand());
  program.addCommand(indexCommand());
  program.addCommand(sessionsCommand());
  program.addCommand(searchCommand());
  program.addCommand(exportCommand());
  program.addCommand(queryCommand());
  program.addCommand(mcpCommand());
  program.addCommand(tuiCommand());

  await program.parseAsync([...argv]);
}

// Auto-execute when invoked as the entry point (`node dist/cli/main.js …` or
// via the `prosa` bin shim). Importing this file as a library still gives
// `runCli` without side effects.
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  runCli(process.argv).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
