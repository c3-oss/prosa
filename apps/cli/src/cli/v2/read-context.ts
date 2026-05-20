// Lane 7 — resolve the read context for a `prosa read *` command.
//
// Bridges the existing CLI promotion config + auth state with the
// new v2 authority cache + reads client. The `auto` authority mode
// honors the recorded v2 promotion: when the store has a v2
// promotion receipt the CLI must talk to the server; when there is
// no recorded promotion the CLI reads the local bundle.
//
// The L11 "auto chooses local if a local bundle exists AND its
// bundleRoot matches the cached receipt's bundleRoot" branch is
// delegated to the MCP serve slice (which fully owns the local v2
// bundle openers). For the `prosa read *` group, `auto` resolves to
// `remote` for promoted stores and `local` otherwise — surfacing the
// same fail-closed guidance the v1 routing already emits via
// CQ-143.

import path from 'node:path'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import {
  type PromotionRecord,
  type ProsaCliConfig,
  type ProsaServerEntry,
  activeEntry,
  defaultConfigPath,
  loadCliConfig,
} from '../auth/config.js'
import { CliUserError } from '../errors.js'
import { type CachedAuthorityV2, defaultV2AuthorityDir, resolveAuthority } from './authority/index.js'
import { V2ReadsClient } from './client/index.js'

/** Authority pinning mode requested by the caller. */
export type AuthorityMode = 'auto' | 'local' | 'remote'

export type V2ReadContextRemote = {
  kind: 'remote'
  client: V2ReadsClient
  authority: CachedAuthorityV2
  entry: ProsaServerEntry
  storePath: string
  storeId: string
}

export type V2ReadContextLocal = {
  kind: 'local'
  storePath: string
}

export type V2ReadContext = V2ReadContextRemote | V2ReadContextLocal

export type ResolveV2ReadContextOptions = {
  commandName: string
  storePath: string
  authorityMode?: AuthorityMode
  forceRefresh?: boolean
  offline?: boolean
  configPath?: string
  authorityDir?: string
  /** Inject for tests. */
  fetch?: typeof fetch
  now?: () => number
}

export async function resolveV2ReadContext(opts: ResolveV2ReadContextOptions): Promise<V2ReadContext> {
  const mode: AuthorityMode = opts.authorityMode ?? 'auto'
  const resolvedStore = path.resolve(opts.storePath)
  const config = await loadCliConfig(opts.configPath ?? defaultConfigPath())
  const promoted = findV2Promotion(config, resolvedStore)

  if (mode === 'local') {
    return { kind: 'local', storePath: resolvedStore }
  }

  if (mode === 'remote' && !promoted) {
    throw new CliUserError(
      `${opts.commandName} requires --authority remote but no v2-promoted store is recorded for ${resolvedStore}.`,
    )
  }

  if (mode === 'auto' && !promoted) {
    return { kind: 'local', storePath: resolvedStore }
  }

  if (!promoted) {
    return { kind: 'local', storePath: resolvedStore }
  }

  const { entry, promotion, receipt } = promoted
  if (!entry.token) {
    throw new CliUserError(
      `${opts.commandName} needs remote access for promoted store ${resolvedStore}, but you are not logged in.\nRun \`prosa auth login --server ${entry.url}\` and retry, or use --authority local to read the local bundle.`,
    )
  }
  if (!promotion.tenantId) {
    throw new CliUserError(
      `${opts.commandName} cannot resolve the promoted store tenant for ${resolvedStore}.\nRun \`prosa sync status\` to inspect promotion state.`,
    )
  }

  const storeId = receipt.payload.storeId
  const authority = await resolveAuthority({
    configDir: opts.authorityDir ?? defaultV2AuthorityDir(),
    serverUrl: entry.url,
    tenantId: promotion.tenantId,
    storeId,
    token: entry.token,
    forceRefresh: opts.forceRefresh ?? false,
    offline: opts.offline ?? false,
    fetch: opts.fetch,
    now: opts.now,
  })

  const client = new V2ReadsClient({
    baseUrl: entry.url,
    token: entry.token,
    tenantId: promotion.tenantId,
    fetch: opts.fetch,
  })

  return {
    kind: 'remote',
    client,
    authority,
    entry,
    storePath: resolvedStore,
    storeId,
  }
}

type V2Promotion = {
  entry: ProsaServerEntry
  promotion: PromotionRecord
  receipt: PromotionReceiptV2
}

function findV2Promotion(config: ProsaCliConfig, storePath: string): V2Promotion | null {
  const candidates: ProsaServerEntry[] = []
  const active = activeEntry(config)
  if (active) candidates.push(active)
  for (const entry of Object.values(config.servers)) {
    if (entry !== active) candidates.push(entry)
  }
  for (const entry of candidates) {
    const promotion = entry.promotions?.[storePath]
    if (!promotion) continue
    const receipt = asV2Receipt(promotion.receipt)
    if (!receipt) continue
    return { entry, promotion, receipt }
  }
  return null
}

function asV2Receipt(value: unknown): PromotionReceiptV2 | null {
  if (!value || typeof value !== 'object') return null
  const payload = (value as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object') return null
  const version = (payload as { receiptVersion?: unknown }).receiptVersion
  const storeId = (payload as { storeId?: unknown }).storeId
  if (version !== 2) return null
  if (typeof storeId !== 'string' || storeId.length === 0) return null
  return value as PromotionReceiptV2
}
