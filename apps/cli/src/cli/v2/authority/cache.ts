// Lane 7 — on-disk authority cache.
//
// `getCachedAuthority` and `writeCachedAuthority` persist the
// `CachedAuthorityV2` record under
// `<configDir>/authority/<storeId>.json`. The default config dir
// honors `PROSA_CONFIG_PATH`, then `XDG_CONFIG_HOME`, then
// `~/.config/prosa`, matching the existing CLI auth config layout.
// All writes are mode 0600 so the cached receipt + server URL never
// leak to other users on the host.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CachedAuthorityV2 } from './types.js'

/**
 * Interactive read TTL — 60 s per the L12 contract. Within the TTL
 * the CLI must not hit the network. Outside the TTL or on explicit
 * `--refresh` the CLI re-issues `GET /v2/stores/:storeId/authority`.
 */
export const AUTHORITY_TTL_MS = 60_000

/** Default `<configDir>` for the v2 authority cache. */
export function defaultV2AuthorityDir(): string {
  const override = process.env.PROSA_AUTHORITY_DIR
  if (override) return override
  const configRoot = process.env.PROSA_CONFIG_PATH
  if (configRoot) return path.join(path.dirname(configRoot), 'authority')
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), '.config')
  return path.join(base, 'prosa', 'authority')
}

function authorityFile(dir: string, storeId: string): string {
  const safe = encodeURIComponent(storeId)
  return path.join(dir, `${safe}.json`)
}

async function repairCachePermissions(filePath: string): Promise<void> {
  try {
    const stats = await stat(filePath)
    const mode = stats.mode & 0o777
    if ((mode & 0o077) === 0) return
    await import('node:fs/promises').then((m) => m.chmod(filePath, 0o600))
  } catch {
    // Best-effort; missing file is the common case.
  }
}

/** Read the cached authority for `storeId` or null when no record exists. */
export async function getCachedAuthority(dir: string, storeId: string): Promise<CachedAuthorityV2 | null> {
  const file = authorityFile(dir, storeId)
  try {
    await repairCachePermissions(file)
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as CachedAuthorityV2
    if (!parsed.storeId || !parsed.receiptId || !parsed.expiresAt) return null
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Persist (or replace) the cached authority for `storeId`. */
export async function writeCachedAuthority(dir: string, value: CachedAuthorityV2): Promise<void> {
  const file = authorityFile(dir, value.storeId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** Remove the cached authority for `storeId`. */
export async function clearCachedAuthority(dir: string, storeId: string): Promise<void> {
  await rm(authorityFile(dir, storeId), { force: true })
}

/** True when the cached entry has not yet expired at `nowMs`. */
export function isFresh(cached: CachedAuthorityV2, nowMs: number): boolean {
  const expiresAt = Date.parse(cached.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > nowMs
}
