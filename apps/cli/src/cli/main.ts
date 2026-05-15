#!/usr/bin/env node
import { PROSA_PARSER_VERSION } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { analyticsCommand } from './commands/analytics.js'
import { compileAllCommand, compileCommand } from './commands/compile.js'
import { doctorCommand } from './commands/doctor.js'
import { exportCommand } from './commands/export.js'
import { indexCommand } from './commands/index.js'
import { initCommand } from './commands/init.js'
import { mcpCommand } from './commands/mcp.js'
import { queryCommand } from './commands/query.js'
import { searchCommand } from './commands/search.js'
import { sessionsCommand } from './commands/sessions.js'
import { tuiCommand } from './commands/tui.js'
import { isCliUserError } from './errors.js'

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
  program.addCommand(searchCommand())
  program.addCommand(exportCommand())
  program.addCommand(queryCommand())
  program.addCommand(analyticsCommand())
  program.addCommand(doctorCommand())
  program.addCommand(mcpCommand())
  program.addCommand(tuiCommand())

  await program.parseAsync(stripLeadingDoubleDash(argv))
}

// Auto-execute when invoked as the entry point (`node dist/cli/main.js …` or
// via the `prosa` bin shim). Importing this file as a library still gives
// `runCli` without side effects.
const isEntry = import.meta.url === `file://${process.argv[1]}`
if (isEntry) {
  runCli(process.argv).catch((error: unknown) => {
    if (isCliUserError(error)) {
      process.stderr.write(`${error.message}\n`)
      process.exit(error.exitCode)
    }
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
}
