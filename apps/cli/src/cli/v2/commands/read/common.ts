// Lane 7 — shared options + helpers for `prosa read *` commands.
//
// Centralizes:
//   - the common option set (--store, --authority, --refresh,
//     --offline, --server, --config);
//   - `prepareV2Read` which resolves the read context;
//   - `with412RefreshAndRetry` which implements CQ-152: refresh
//     authority once on HTTP 412 for idempotent single-page reads,
//     retry, then stop with an explicit AuthorityChangedError if
//     the second attempt still 412s.
//   - `with412FailClosed` for multi-page / streaming output that
//     refuses to mix snapshots.

import { defaultBundlePath } from '@c3-oss/prosa-core'
import type { Command } from 'commander'
import { CliUserError } from '../../../errors.js'
import { type OutputFormat, parseOutputFormat } from '../../../output.js'
import { AuthorityChangedError, defaultV2AuthorityDir, refreshAuthorityNow } from '../../authority/index.js'
import { AuthorityChangedHttpError, V2ReadsClient } from '../../client/index.js'
import {
  type AuthorityMode,
  type V2ReadContext,
  type V2ReadContextRemote,
  resolveV2ReadContext,
} from '../../read-context.js'

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
 * CQ-152 — idempotent single-page read policy.
 *
 * Run `fn(ctx)`. If the server returns HTTP 412, refresh authority
 * once (force a network call), rebuild a client with the refreshed
 * cached entry, retry once. If the retry still 412s, stop with
 * `AuthorityChangedError` so the operator can rerun deliberately.
 *
 * Local-mode contexts (no v2 promotion) pass through unchanged.
 *
 * Streaming or multi-page consumers must NOT use this helper —
 * they would risk emitting a transcript / page list that mixes two
 * receipt snapshots. They should call the client directly and
 * fail closed on `AuthorityChangedHttpError`.
 */
export async function with412RefreshAndRetry<T>(
  ctx: V2ReadContext,
  fn: (ctx: V2ReadContext) => Promise<T>,
): Promise<T> {
  try {
    return await fn(ctx)
  } catch (err) {
    if (!(err instanceof AuthorityChangedHttpError) || ctx.kind !== 'remote') throw err
    const refreshed = await refreshRemote(ctx)
    try {
      return await fn(refreshed)
    } catch (retryErr) {
      if (retryErr instanceof AuthorityChangedHttpError) {
        throw new AuthorityChangedError(
          'authority changed twice in a row (HTTP 412); rerun the command to use the latest receipt.',
        )
      }
      throw retryErr
    }
  }
}

async function refreshRemote(ctx: V2ReadContextRemote): Promise<V2ReadContextRemote> {
  if (!ctx.entry.token) {
    throw new AuthorityChangedError(
      'authority changed mid-command (HTTP 412) and the CLI has no token to refresh; run `prosa auth login` and rerun.',
    )
  }
  const refreshed = await refreshAuthorityNow({
    configDir: defaultV2AuthorityDir(),
    serverUrl: ctx.entry.url,
    tenantId: ctx.client.tenantId,
    storeId: ctx.storeId,
    token: ctx.entry.token,
    knownReceiptId: ctx.authority.receiptId,
  })
  const nextClient = new V2ReadsClient({
    baseUrl: ctx.entry.url,
    token: ctx.entry.token,
    tenantId: ctx.client.tenantId,
  })
  return {
    ...ctx,
    client: nextClient,
    authority: refreshed,
  }
}

export { parseOutputFormat }
export type { OutputFormat }
