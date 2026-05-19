#!/usr/bin/env node
import { PROSA_PARSER_VERSION } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { analyticsCommand } from './commands/analytics.js'
import { authCommand } from './commands/auth.js'
import { bundleCommand } from './commands/bundle.js'
import { compileAllV2Command, compileV2Command } from './commands/compile-v2.js'
import { compileAllCommand, compileCommand } from './commands/compile.js'
import { doctorCommand } from './commands/doctor.js'
import { exportCommand } from './commands/export.js'
import { indexCommand } from './commands/index.js'
import { initCommand } from './commands/init.js'
import { mcpCommand } from './commands/mcp.js'
import { queryCommand } from './commands/query.js'
import { searchCommand } from './commands/search.js'
import { sessionCommand } from './commands/session.js'
import { sessionsCommand } from './commands/sessions.js'
import { syncCommand } from './commands/sync.js'
import { tuiCommand } from './commands/tui.js'
/**
 * Drop a leading literal `--` token from the user-args portion of argv.
 *
 * `pnpm dev -- compile codex --overwrite` expands the script invocation to
 * `node prosa.ts -- compile codex --overwrite` — pnpm passes the `--`
 * through verbatim. Combined with Commander's `enablePositionalOptions()`,
 * Commander treats the `--` as the option terminator and silently ignores
 * every flag that follows. Stripping it once at the entrypoint lets both
 * `pnpm dev -- compile …` and the direct `node prosa.ts compile …` form
 * accept flags identically.
 */
function stripLeadingDoubleDash(argv: readonly string[]): string[] {
  if (argv.length >= 3 && argv[2] === '--') {
    return [argv[0]!, argv[1]!, ...argv.slice(3)]
  }
  return [...argv]
}

/** Build and run the prosa CLI program for the provided process argv vector. */
export async function runCli(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name('prosa')
    .enablePositionalOptions()
    .description(
      'Compile, search and export local agent session histories\n' +
        '(Cursor, Codex CLI, Claude Code, Gemini CLI, Hermes) into one canonical store.',
    )
    .version(PROSA_PARSER_VERSION, '-v, --version')

  program.addCommand(initCommand())
  program.addCommand(compileCommand())
  program.addCommand(compileAllCommand())
  program.addCommand(indexCommand())
  program.addCommand(sessionsCommand())
  program.addCommand(sessionCommand())
  program.addCommand(searchCommand())
  program.addCommand(exportCommand())
  program.addCommand(queryCommand())
  program.addCommand(analyticsCommand())
  program.addCommand(doctorCommand())
  program.addCommand(mcpCommand())
  program.addCommand(tuiCommand())
  program.addCommand(authCommand())
  program.addCommand(syncCommand())
  program.addCommand(bundleCommand())
  program.addCommand(compileV2Command())
  program.addCommand(compileAllV2Command())

  await program.parseAsync(stripLeadingDoubleDash(argv))
}
