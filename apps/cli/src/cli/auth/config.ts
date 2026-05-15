import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Local CLI configuration, kept outside the .prosa bundle. */
export type ProsaCliConfig = {
  /** Per-server entries keyed by base URL. */
  servers: Record<string, ProsaServerEntry>
  /** URL of the active server (chosen by `auth login` / `auth use`). */
  activeServer?: string
}

export type ProsaServerEntry = {
  url: string
  user?: { id: string; email: string; name?: string }
  token?: string
  device?: { id: string; name: string }
  activeTenant?: { id: string; name?: string; slug?: string | null }
  /** Map of former-local-store path → promotion receipt. */
  promotions?: Record<string, PromotionRecord>
}

export type PromotionRecord = {
  batchId: string
  tenantId: string
  promotedAt: string
  receipt: unknown
  cleanupCompletedAt?: string
}

export function defaultConfigPath(): string {
  const override = process.env.PROSA_CONFIG_PATH
  if (override) return override
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), '.config')
  return path.join(base, 'prosa', 'config.json')
}

const EMPTY: ProsaCliConfig = { servers: {} }

export async function loadCliConfig(filePath = defaultConfigPath()): Promise<ProsaCliConfig> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as ProsaCliConfig
    if (!parsed.servers || typeof parsed.servers !== 'object') parsed.servers = {}
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY }
    throw err
  }
}

export async function saveCliConfig(config: ProsaCliConfig, filePath = defaultConfigPath()): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

export async function clearCliConfig(filePath = defaultConfigPath()): Promise<void> {
  await rm(filePath, { force: true })
}

export function activeEntry(config: ProsaCliConfig): ProsaServerEntry | null {
  if (!config.activeServer) return null
  return config.servers[config.activeServer] ?? null
}

export function upsertServer(config: ProsaCliConfig, entry: ProsaServerEntry, makeActive = true): ProsaCliConfig {
  const next: ProsaCliConfig = {
    ...config,
    servers: { ...config.servers, [entry.url]: { ...config.servers[entry.url], ...entry } },
  }
  if (makeActive) next.activeServer = entry.url
  return next
}

export function recordPromotion(entry: ProsaServerEntry, storePath: string, record: PromotionRecord): ProsaServerEntry {
  return {
    ...entry,
    promotions: { ...(entry.promotions ?? {}), [storePath]: record },
  }
}

export function isPromoted(entry: ProsaServerEntry, storePath: string): boolean {
  return Boolean(entry.promotions?.[storePath])
}
