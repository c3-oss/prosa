// Lane 7 — shared options + helpers for `prosa read *` commands.
//
// Centralizes:
//   - the common option set (--store, --authority, --refresh,
//     --offline, --server, --config) so every subcommand shares the
//     same vocabulary;
//   - the `prepareV2Read` helper that resolves the read context,
//     installs the 412 mid-command policy, and feeds the cached
//     authority into the typed client.

import { defaultBundlePath } from '@c3-oss/prosa-core'
import type { Command } from 'commander'
import { CliUserError } from '../../../errors.js'
import { type OutputFormat, parseOutputFormat } from '../../../output.js'
import { AuthorityChangedError } from '../../authority/index.js'
import { AuthorityChangedHttpError } from '../../client/index.js'
import { type AuthorityMode, type V2ReadContext, resolveV2ReadContext } from '../../read-context.js'

export type CommonReadOptions = {
  store: string
  authority: AuthorityMode
  refresh: boolean
  offline: boolean
  server?: string
  config?: string
}

/** Add the shared option set used by every `prosa read *` subcommand. */
export function addCommonReadOptions(cmd: Command): Command {
  return cmd
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option(
      '--authority <mode>',
      'authority mode: auto|local|remote (default: auto)',
      parseAuthorityMode,
      'auto' as AuthorityMode,
    )
    .option('--refresh', 'force a remote authority refresh', false)
    .option('--offline', 'use the cached authority; never hit the network', false)
    .option('--server <url>', 'override server URL for the active config')
    .option('--config <path>', 'override CLI config path')
}

function parseAuthorityMode(value: string): AuthorityMode {
  if (value === 'auto' || value === 'local' || value === 'remote') return value
  throw new CliUserError(`invalid --authority value: ${value} (expected auto|local|remote)`)
}

/** Resolve the v2 read context honoring the common options. */
export async function prepareV2Read(opts: {
  commandName: string
  options: CommonReadOptions
}): Promise<V2ReadContext> {
  return resolveV2ReadContext({
    commandName: opts.commandName,
    storePath: opts.options.store,
    authorityMode: opts.options.authority,
    forceRefresh: opts.options.refresh,
    offline: opts.options.offline,
    configPath: opts.options.config,
  })
}

/**
 * Wrap an idempotent read so that an HTTP 412 from the server (the
 * receipt the CLI carried is no longer the current authority)
 * triggers one refresh + retry. If the refresh produces a different
 * receipt id, the second attempt may again return 412 — at that
 * point the caller is asked to rerun.
 *
 * For streaming output (`--all-pages`), callers should opt out and
 * surface an explicit "authority changed" message instead.
 */
export async function with412Retry<T>(ctx: V2ReadContext, fn: (ctx: V2ReadContext) => Promise<T>): Promise<T> {
  try {
    return await fn(ctx)
  } catch (err) {
    if (!(err instanceof AuthorityChangedHttpError)) throw err
    if (ctx.kind !== 'remote') throw err
    throw new AuthorityChangedError(
      'authority changed mid-command (HTTP 412); rerun the command to use the refreshed receipt.',
    )
  }
}

export { parseOutputFormat }
export type { OutputFormat }
