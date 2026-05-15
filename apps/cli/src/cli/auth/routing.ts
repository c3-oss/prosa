import path from 'node:path'
import { ProsaApiClient } from './client.js'
import { type ProsaServerEntry, activeEntry, defaultConfigPath, isPromoted, loadCliConfig } from './config.js'

export type ReadAuthority =
  | { kind: 'local'; storePath: string }
  | { kind: 'remote'; client: ProsaApiClient; entry: ProsaServerEntry; storePath: string }

/**
 * Decide whether a read command should hit the server or the local bundle.
 *
 * Resolution order:
 *   1. If a CLI config exists with an active server and the resolved store
 *      path has a promotion receipt for that server, return remote authority.
 *   2. Otherwise, return local authority with the resolved store path.
 *
 * Special override: passing `--store` always wins; if the override path is
 * not promoted, we read locally even if a different store has been promoted.
 */
export async function resolveReadAuthority(opts: {
  storePath?: string
  forceLocal?: boolean
  configPath?: string
}): Promise<ReadAuthority> {
  const resolvedStore = path.resolve(opts.storePath ?? '')
  if (opts.forceLocal || !resolvedStore) {
    return { kind: 'local', storePath: resolvedStore }
  }
  const config = await loadCliConfig(opts.configPath ?? defaultConfigPath())
  const entry = activeEntry(config)
  if (!entry || !entry.token) {
    return { kind: 'local', storePath: resolvedStore }
  }
  if (!isPromoted(entry, resolvedStore)) {
    return { kind: 'local', storePath: resolvedStore }
  }
  const client = new ProsaApiClient({
    baseUrl: entry.url,
    token: entry.token,
    ...(entry.activeTenant?.id ? { tenantId: entry.activeTenant.id } : {}),
  })
  return { kind: 'remote', client, entry, storePath: resolvedStore }
}
