import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { PromotionReceipt } from '@c3-oss/prosa-sync'
import type { ProsaApiClient } from '../auth/client.js'
import { type LocalBundleUpload, type LocalCasObject, readLocalCasObjectBytes } from './bundle.js'
import { mapConcurrent } from './concurrency.js'

export type SyncMetrics = {
  planMs: number
  uploadMs: number
  commitMs: number
  verifyMs: number
  totalMs: number
  localScanMs: number
  localReadMs: number
  localBytesRead: number
  localObjectsRead: number
  bytesUploaded: number
  rowsCommitted: number
  objectsDeclared: number
  objectsMissing: number
  objectsUploaded: number
  batches: number
  objectConcurrency: number
}

export type SyncPromotionResult = {
  batchId: string
  sessionCount: number
  objectCount: number
  searchDocCount: number
  receipt: PromotionReceipt
  metrics: SyncMetrics
}

type PromoteUploadOptions = {
  client: ProsaApiClient
  deviceId: string
  storePath: string
  upload: LocalBundleUpload
  objectConcurrency: number
  verbose?: boolean
}

export function emptySyncMetrics(objectConcurrency: number): SyncMetrics {
  return {
    planMs: 0,
    uploadMs: 0,
    commitMs: 0,
    verifyMs: 0,
    totalMs: 0,
    localScanMs: 0,
    localReadMs: 0,
    localBytesRead: 0,
    localObjectsRead: 0,
    bytesUploaded: 0,
    rowsCommitted: 0,
    objectsDeclared: 0,
    objectsMissing: 0,
    objectsUploaded: 0,
    batches: 0,
    objectConcurrency,
  }
}

export function mergeSyncMetrics(left: SyncMetrics, right: SyncMetrics): SyncMetrics {
  return {
    planMs: left.planMs + right.planMs,
    uploadMs: left.uploadMs + right.uploadMs,
    commitMs: left.commitMs + right.commitMs,
    verifyMs: left.verifyMs + right.verifyMs,
    totalMs: left.totalMs + right.totalMs,
    localScanMs: left.localScanMs + right.localScanMs,
    localReadMs: left.localReadMs + right.localReadMs,
    localBytesRead: left.localBytesRead + right.localBytesRead,
    localObjectsRead: left.localObjectsRead + right.localObjectsRead,
    bytesUploaded: left.bytesUploaded + right.bytesUploaded,
    rowsCommitted: left.rowsCommitted + right.rowsCommitted,
    objectsDeclared: left.objectsDeclared + right.objectsDeclared,
    objectsMissing: left.objectsMissing + right.objectsMissing,
    objectsUploaded: left.objectsUploaded + right.objectsUploaded,
    batches: left.batches + right.batches,
    objectConcurrency: right.objectConcurrency,
  }
}

async function bytesForUpload(storePath: string, object: LocalCasObject, metrics: SyncMetrics): Promise<Uint8Array> {
  if (object.bytes) return object.bytes
  const readStart = Date.now()
  const bytes = await readLocalCasObjectBytes(storePath, object)
  metrics.localReadMs += Date.now() - readStart
  metrics.localBytesRead += bytes.byteLength
  metrics.localObjectsRead += 1
  object.bytes = bytes
  return bytes
}

export async function promoteUpload({
  client,
  deviceId,
  storePath,
  upload,
  objectConcurrency,
  verbose,
}: PromoteUploadOptions): Promise<SyncPromotionResult> {
  const { casObjects, projection, rawRecords, searchDocs, sessions, sourceFiles, toolCalls, toolResults } = upload
  const objectEntries = casObjects.map((c) => c.entry)
  const metrics = emptySyncMetrics(objectConcurrency)
  metrics.batches = 1
  metrics.objectsDeclared = casObjects.length
  metrics.localScanMs = upload.metrics.localScanMs
  metrics.localReadMs = upload.metrics.localReadMs
  metrics.localBytesRead = upload.metrics.localBytesRead
  metrics.localObjectsRead = upload.metrics.localObjectsRead
  const totalStart = Date.now()

  const planStart = Date.now()
  const plan = await client.syncPlanUpload({
    deviceId,
    storePath,
    objects: objectEntries,
  })
  metrics.planMs += Date.now() - planStart
  metrics.objectsMissing = plan.missingObjectIds.length
  if (verbose) {
    process.stderr.write(
      `plan ok • batchId=${plan.batchId} declaredObjects=${casObjects.length} missingObjects=${plan.missingObjectIds.length} planMs=${metrics.planMs}\n`,
    )
  }

  const missingSet = new Set(plan.missingObjectIds)
  const missingObjects = casObjects.filter(({ entry }) => missingSet.has(entry.objectId))
  const uploadStart = Date.now()
  await mapConcurrent(missingObjects, objectConcurrency, async (object) => {
    const { entry: obj } = object
    const bytes = await bytesForUpload(storePath, object, metrics)
    await client.uploadObjectBytes({
      batchId: plan.batchId,
      objectId: obj.objectId,
      hash: obj.hash,
      ...(obj.transportHash ? { transportHash: obj.transportHash } : {}),
      compression: obj.compression,
      compressedSize: obj.compressedSize,
      uncompressedSize: obj.uncompressedSize,
      bytes,
    })
    metrics.bytesUploaded += bytes.byteLength
    metrics.objectsUploaded += 1
  })
  metrics.uploadMs += Date.now() - uploadStart
  if (verbose && casObjects.length > 0) {
    process.stderr.write(
      `uploaded ${missingSet.size} CAS objects bytes=${metrics.bytesUploaded} uploadMs=${metrics.uploadMs}\n`,
    )
  }

  const commitStart = Date.now()
  const commit = await client.syncCommitUpload({
    batchId: plan.batchId,
    deviceId,
    storePath,
    objects: objectEntries,
    projection,
  })
  metrics.commitMs += Date.now() - commitStart
  metrics.rowsCommitted += commit.committedRows
  if (verbose) {
    process.stderr.write(
      `commit ok • objects=${commit.committedObjects} rows=${commit.committedRows} commitMs=${metrics.commitMs}\n`,
    )
  }

  const verifyStart = Date.now()
  const verify = await client.syncVerifyPromotion({
    batchId: plan.batchId,
    storePath,
    sampleSessionIds: sessions.slice(0, 5).map((s) => s.id),
    declaredObjectIds: objectEntries.map((obj) => obj.objectId),
    declaredSourceFileIds: sourceFiles.map((s) => s.id),
    declaredRawRecordIds: rawRecords.map((r) => r.id),
    declaredSessionIds: sessions.map((s) => s.id),
    declaredSearchDocIds: searchDocs.map((d) => d.id),
    declaredToolCallIds: toolCalls.map((c) => c.id),
    declaredToolResultIds: toolResults.map((r) => r.id),
  })
  metrics.verifyMs += Date.now() - verifyStart
  metrics.totalMs += Date.now() - totalStart
  if (verbose) {
    process.stderr.write(`verify ok • verifyMs=${metrics.verifyMs} totalMs=${metrics.totalMs}\n`)
  }

  return {
    batchId: plan.batchId,
    sessionCount: verify.receipt.sessionCount,
    objectCount: verify.receipt.objectCount,
    searchDocCount: verify.receipt.searchDocCount,
    receipt: verify.receipt,
    metrics,
  }
}

/**
 * Cleanup model:
 *  - Default cleanup removes only DERIVED artifacts that can be regenerated
 *    from canonical source (or from the server after promotion).
 *  - `--purge-bundle` opts into removing the canonical raw/CAS data and the
 *    manifest. This is destructive, so it only runs after the server emits a
 *    promotion receipt for the declared CAS and projection rows.
 *
 * Default cleanup preserves `objects/`, `raw/`, `prosa.sqlite`, and
 * `manifest.json` while marking the store remote-authoritative via the
 * promotion receipt.
 */
const DERIVED_PATHS_TO_REMOVE = ['search', 'parquet', 'exports']
const CANONICAL_PATHS_TO_REMOVE = ['prosa.sqlite', 'manifest.json', 'objects', 'raw']

export async function removeLocalBundle(storePath: string, purge: boolean): Promise<string[]> {
  const entries = purge ? [...DERIVED_PATHS_TO_REMOVE, ...CANONICAL_PATHS_TO_REMOVE] : DERIVED_PATHS_TO_REMOVE
  const removed: string[] = []
  for (const entry of entries) {
    const target = path.join(storePath, entry)
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      // Best-effort cleanup; cleanup retries on next command.
    }
  }
  return removed
}
