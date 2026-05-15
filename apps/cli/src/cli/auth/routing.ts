import path from 'node:path'
import { CliUserError } from '../errors.js'
import { ProsaApiClient } from './client.js'
import { type PromotionRecord, type ProsaServerEntry, activeEntry, defaultConfigPath, loadCliConfig } from './config.js'

export type ReadAuthority =
  | { kind: 'local'; storePath: string }
  | { kind: 'remote'; client: ProsaApiClient; entry: ProsaServerEntry; storePath: string }

type PromotedStore = {
  entry: ProsaServerEntry
  promotion: PromotionRecord
}

/**
 * Decide whether a read command should hit the server or the local bundle.
 *
 * Resolution order:
 *   1. If the resolved store path has a promotion receipt, return remote
 *      authority or fail closed if remote is unsupported.
 *   2. If `--local` was provided, read locally and print an explicit stale
 *      warning when the store has a promotion receipt.
 *   3. Otherwise, return local authority with the resolved store path.
 */
export async function resolveReadAuthority(opts: {
  storePath?: string
  forceLocal?: boolean
  configPath?: string
}): Promise<ReadAuthority> {
  return resolveReadAuthorityOrFailClosed({
    commandName: 'read command',
    storePath: opts.storePath,
    forceLocal: opts.forceLocal,
    configPath: opts.configPath,
    remoteSupported: true,
  })
}

/** Resolve authority and prevent promoted stores from silently falling back to local data. */
export async function resolveReadAuthorityOrFailClosed(opts: {
  commandName: string
  storePath?: string
  forceLocal?: boolean
  configPath?: string
  remoteSupported: boolean
}): Promise<ReadAuthority> {
  const resolvedStore = path.resolve(opts.storePath ?? '')
  if (!resolvedStore) {
    return { kind: 'local', storePath: resolvedStore }
  }

  const config = await loadCliConfig(opts.configPath ?? defaultConfigPath())
  const promoted = findPromotedStore(config, resolvedStore)
  if (!promoted) {
    return { kind: 'local', storePath: resolvedStore }
  }

  if (opts.forceLocal) {
    process.stderr.write(
      `${opts.commandName}: using local bundle for remote-authoritative store ${resolvedStore} ` +
        `(promoted to ${promoted.entry.url}). Results may be stale.\n`,
    )
    return { kind: 'local', storePath: resolvedStore }
  }

  if (!opts.remoteSupported) {
    throw new CliUserError(
      `${opts.commandName} is not available for remote-authoritative store ${resolvedStore} yet.\nThis store was promoted to ${promoted.entry.url}; refusing to read a stale or missing local bundle by default.\nUse --local to read the local bundle explicitly.`,
    )
  }

  if (!promoted.entry.token) {
    throw new CliUserError(
      `${opts.commandName} needs remote access for promoted store ${resolvedStore}, but you are not logged in.\nRun \`prosa auth login --server ${promoted.entry.url}\` and retry, or use --local to read local state explicitly.`,
    )
  }

  if (!promoted.promotion.tenantId) {
    throw new CliUserError(
      `${opts.commandName} cannot resolve the promoted store tenant for ${resolvedStore}.\nRun \`prosa sync status\` to inspect promotion state, or use --local to read local state explicitly.`,
    )
  }

  const client = new ProsaApiClient({
    baseUrl: promoted.entry.url,
    token: promoted.entry.token,
    tenantId: promoted.promotion.tenantId,
  })
  return { kind: 'remote', client, entry: promoted.entry, storePath: resolvedStore }
}

function findPromotedStore(
  config: { servers: Record<string, ProsaServerEntry>; activeServer?: string },
  storePath: string,
): PromotedStore | null {
  const active = activeEntry(config)
  const activePromotion = active?.promotions?.[storePath]
  if (active && activePromotion) {
    return { entry: active, promotion: activePromotion }
  }

  for (const entry of Object.values(config.servers)) {
    const promotion = entry.promotions?.[storePath]
    if (promotion) {
      return { entry, promotion }
    }
  }

  return null
}
