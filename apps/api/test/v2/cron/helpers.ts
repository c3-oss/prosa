// Shared helpers for Lane 8 audit + GC tests.
//
// All tests share the same minimal seed surface: a tenant id, one or
// more `remote_pack` rows, optional `remote_pack_entry` + receipt grant
// rows, and a `MemoryObjectStore` populated with the matching pack
// bytes. The helpers below keep the test files readable and focused on
// the behaviour they exercise.

import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore, PUT_PREVERIFIED_BYTES } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import type { DriftLogger, DriftMetrics, DriftTxRunner } from '../../../src/cron/audit/drift.js'
import type { RawExec } from '../../../src/db.js'

export type CronTestHarness = {
  pglite: PGlite
  rawExec: RawExec
  transaction: DriftTxRunner
  store: MemoryObjectStore
  logger: DriftLogger
  metrics: TestMetrics
  close: () => Promise<void>
}

export type TestMetrics = DriftMetrics & {
  events: Array<{ name: string; tags: Record<string, string> }>
}

export function makeTestMetrics(): TestMetrics {
  const events: Array<{ name: string; tags: Record<string, string> }> = []
  return {
    events,
    increment(name, tags = {}) {
      events.push({ name, tags })
    },
  }
}

export function makeTestLogger(): DriftLogger {
  return {
    warn: () => {},
    error: () => {},
  }
}

/**
 * Spin up a fresh PGlite + MemoryObjectStore + the v2 schema subset.
 * Returns the standard set of cron dependencies.
 */
export async function buildCronTestHarness(): Promise<CronTestHarness> {
  const pglite = new PGlite()
  // The conflict-free subset depends on the v1 schema being present
  // first (CQ-124). Mirror the production boot sequence.
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  const rawExec: RawExec = async (sql, params = []) => {
    const result = await pglite.query(sql, params as never[])
    return result.rows as never
  }
  const transaction: DriftTxRunner = async (fn) => {
    await pglite.exec('BEGIN')
    try {
      const result = await fn(rawExec)
      await pglite.exec('COMMIT')
      return result
    } catch (err) {
      await pglite.exec('ROLLBACK')
      throw err
    }
  }
  const store = new MemoryObjectStore()
  return {
    pglite,
    rawExec,
    transaction,
    store,
    logger: makeTestLogger(),
    metrics: makeTestMetrics() as TestMetrics,
    close: async () => {
      await pglite.close()
    },
  }
}

export type SeedPackOptions = {
  tenantId: string
  packDigest: string
  storageUri?: string
  byteLength?: number
  byteHash?: string | null
  ingestedAt?: string
}

/**
 * Insert a `remote_pack` row and optionally seed matching bytes into
 * the test MemoryObjectStore. Returns the storage uri so the caller
 * can mutate or delete the bytes later.
 */
export async function seedRemotePack(harness: CronTestHarness, opts: SeedPackOptions): Promise<string> {
  const storageUri = opts.storageUri ?? `object-packs/${opts.tenantId}/test/${opts.packDigest}.pack`
  const byteLength = opts.byteLength ?? 256
  const byteHash = opts.byteHash ?? null
  const ingestedAt = opts.ingestedAt ?? 'now()'
  await harness.rawExec(
    `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, byte_hash, object_set_root, storage_uri, ingested_at)
       VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, $5, $6, ${ingestedAt === 'now()' ? 'now()' : '$7'})
       ON CONFLICT DO NOTHING`,
    ingestedAt === 'now()'
      ? [opts.tenantId, opts.packDigest, byteLength, byteHash, 'root', storageUri]
      : [opts.tenantId, opts.packDigest, byteLength, byteHash, 'root', storageUri, ingestedAt],
  )
  return storageUri
}

/**
 * Put a fixed byte payload into the memory object store at the given
 * storage uri. Bypasses verification — the audit cron only HEADs the
 * key for size, not hash, so any bytes that match `byteLength` will
 * pass the parity check.
 */
export async function putPackBytes(store: MemoryObjectStore, storageUri: string, payload: Uint8Array): Promise<void> {
  const meta = {
    hash: '00',
    hashAlgorithm: 'blake3' as const,
    uncompressedSize: payload.byteLength,
    compressedSize: payload.byteLength,
  }
  await store[PUT_PREVERIFIED_BYTES](
    storageUri,
    (async function* () {
      yield new Uint8Array(payload)
    })(),
    meta,
  )
}

export type SeedGrantOptions = {
  tenantId: string
  receiptId: string
  packDigest: string
}

export async function seedReceiptGrant(harness: CronTestHarness, opts: SeedGrantOptions): Promise<void> {
  await harness.rawExec(
    `INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
    [opts.receiptId, opts.tenantId, opts.packDigest],
  )
}
