import type { RawExec } from '../db.js'

export interface BatchManifestRow {
  object_id: string
  canonical_hash: string
  transport_hash: string
  compression: string
  uncompressed_size: number | string
  compressed_size: number | string
}

type CacheEntry = {
  manifest: Map<string, BatchManifestRow>
  expiresAt: number
}

const TTL_MS = 60_000
const MAX_ENTRIES = 256
const cache = new Map<string, CacheEntry>()
const inFlightLoads = new Map<string, Promise<Map<string, BatchManifestRow>>>()

function keyOf(tenantId: string, batchId: string, userId: string): string {
  return `${tenantId}\0${batchId}\0${userId}`
}

function getCachedManifest(key: string, now: number): Map<string, BatchManifestRow> | null {
  const cached = cache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= now) {
    cache.delete(key)
    return null
  }

  // Refresh insertion order so Map's oldest entry is the LRU victim.
  cache.delete(key)
  cache.set(key, cached)
  return cached.manifest
}

function setCachedManifest(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cache.delete(oldest)
  }
}

async function loadManifestFromDb(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  userId: string
}): Promise<Map<string, BatchManifestRow>> {
  const rows = await opts.rawExec<BatchManifestRow>(
    `SELECT m.object_id, m.canonical_hash, m.transport_hash, m.compression,
            m.uncompressed_size, m.compressed_size
       FROM "sync_batch_object_manifest" m
       JOIN "sync_batch" b
         ON b.id = m.batch_id
        AND b.tenant_id = m.tenant_id
        AND b.status = 'open'
        AND b.user_id = $3
      WHERE m.batch_id = $1 AND m.tenant_id = $2`,
    [opts.batchId, opts.tenantId, opts.userId],
  )
  const manifest = new Map<string, BatchManifestRow>()
  for (const row of rows) manifest.set(row.object_id, row)
  return manifest
}

export async function loadBatchManifest(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  userId: string
}): Promise<Map<string, BatchManifestRow>> {
  const key = keyOf(opts.tenantId, opts.batchId, opts.userId)
  const now = Date.now()
  const cached = getCachedManifest(key, now)
  if (cached) return cached

  const inFlight = inFlightLoads.get(key)
  if (inFlight) return inFlight

  const load = (async () => {
    const manifest = await loadManifestFromDb(opts)
    setCachedManifest(key, { manifest, expiresAt: Date.now() + TTL_MS })
    return manifest
  })()
  inFlightLoads.set(key, load)
  try {
    return await load
  } finally {
    if (inFlightLoads.get(key) === load) {
      inFlightLoads.delete(key)
    }
  }
}

export function invalidateBatchManifest(opts: {
  tenantId: string
  batchId: string
  userId: string
}): void {
  cache.delete(keyOf(opts.tenantId, opts.batchId, opts.userId))
}

export function _resetBatchManifestCache(): void {
  cache.clear()
  inFlightLoads.clear()
}
