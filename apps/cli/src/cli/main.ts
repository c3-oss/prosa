#!/usr/bin/env node
import { PROSA_PARSER_VERSION } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { authCommand } from './commands/auth.js'
import { v1Command } from './commands/v1.js'
import { v2Command } from './commands/v2.js'
/**
 * Drop a leading literal `--` token from the user-args portion of argv.
 *
 * `pnpm dev -- v1 compile codex --overwrite` expands the script invocation
 * to `node prosa.ts -- v1 compile codex --overwrite` — pnpm passes the `--`
 * through verbatim. Combined with Commander's `enablePositionalOptions()`,
 * Commander treats the `--` as the option terminator and silently ignores
 * every flag that follows. Stripping it once at the entrypoint lets both
 * `pnpm dev -- v1 compile …` and the direct `node prosa.ts v1 compile …`
 * form accept flags identically.
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
        '(Cursor, Codex CLI, Claude Code, Gemini CLI, Hermes) into one canonical store.\n' +
        '\n' +
        'Use `prosa v1 <command>` for the legacy SQLite-backed surface and\n' +
        '`prosa v2 <command>` for the bundle v2 (NDJSON + Parquet) surface.\n' +
        '`prosa auth` is shared between both versions.',
    )
    .version(PROSA_PARSER_VERSION, '-v, --version')

  program.addCommand(v1Command())
  program.addCommand(v2Command())
  program.addCommand(authCommand())

  await program.parseAsync(stripLeadingDoubleDash(argv))
}
