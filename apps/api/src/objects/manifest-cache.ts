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
const cache = new Map<string, CacheEntry>()

function keyOf(tenantId: string, batchId: string, userId: string): string {
  return `${tenantId} ${batchId} ${userId}`
}

export async function loadBatchManifest(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  userId: string
}): Promise<Map<string, BatchManifestRow>> {
  const key = keyOf(opts.tenantId, opts.batchId, opts.userId)
  const cached = cache.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.manifest

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
  cache.set(key, { manifest, expiresAt: now + TTL_MS })
  return manifest
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
}
