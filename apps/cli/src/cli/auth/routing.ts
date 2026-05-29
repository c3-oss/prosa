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
 * CQ-143: detect a v2 promotion by inspecting the recorded receipt.
 * v2 receipts carry `receiptVersion: 2` in `payload`; v1 receipts do
 * not. The CLI's read clients still route through the legacy
 * `/trpc/sessions.*` surface (gated by the old
 * `sync_batch_projection_manifest` path) which is incompatible with
 * the Lane 6 `remote_authority_v2` gate. Until Lane 7 wires
 * `prosa sessions` to `/v2/reads/*`, the CLI must fail closed for
 * v2-promoted stores and direct the operator to `--local`.
 */
export function isV2Promotion(record: PromotionRecord): boolean {
  const receipt = record.receipt
  if (!receipt || typeof receipt !== 'object') return false
  const payload = (receipt as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object') return false
  const version = (payload as { receiptVersion?: unknown }).receiptVersion
  return version === 2
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

  // CQ-143: the CLI's `remote` path still routes through the legacy
  // `/trpc/sessions.*` endpoints, which use the v1
  // `sync_batch_projection_manifest` gate rather than the Lane 6
  // `remote_authority_v2` receipt-pinned gate. Reading legacy data
  // for a v2-promoted store could expose rows that are no longer
  // current authority. Until Lane 7 wires this command to
  // `/v2/reads/*`, fail closed and redirect to `--local`.
  if (isV2Promotion(promoted.promotion)) {
    throw new CliUserError(
      `${opts.commandName} cannot read the remote-authoritative v2-promoted store ${resolvedStore} yet.\nThis store was promoted to ${promoted.entry.url} via the v2 protocol; the legacy /trpc/sessions.* endpoints are not gated by the v2 receipt authority.\nUntil the CLI wires through /v2/reads/*, use --local to read the local bundle explicitly.`,
    )
  }

  if (!promoted.entry.token) {
    throw new CliUserError(
      `${opts.commandName} needs remote access for promoted store ${resolvedStore}, but you are not logged in.\nRun \`prosa auth login --server ${promoted.entry.url}\` and retry, or use --local to read local state explicitly.`,
    )
  }

  if (!promoted.promotion.tenantId) {
    throw new CliUserError(
      `${opts.commandName} cannot resolve the promoted store tenant for ${resolvedStore}.\nRun \`prosa v1 sync status\` to inspect promotion state, or use --local to read local state explicitly.`,
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
