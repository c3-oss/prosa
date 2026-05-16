import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { PromotionReceipt } from '@c3-oss/prosa-sync'
import type { ProsaApiClient } from '../auth/client.js'
import type { LocalBundleUpload } from './bundle.js'

export type SyncPromotionResult = {
  batchId: string
  sessionCount: number
  objectCount: number
  searchDocCount: number
  receipt: PromotionReceipt
}

type PromoteUploadOptions = {
  client: ProsaApiClient
  deviceId: string
  storePath: string
  upload: LocalBundleUpload
  verbose?: boolean
}

export async function promoteUpload({
  client,
  deviceId,
  storePath,
  upload,
  verbose,
}: PromoteUploadOptions): Promise<SyncPromotionResult> {
  const {
    casObjects,
    projection,
    rawRecords,
    searchDocs,
    sessions,
    sourceFiles,
    toolCalls,
    toolResults,
    messages,
    contentBlocks,
    events,
    artifacts,
  } = upload
  const objectEntries = casObjects.map((c) => c.entry)
  const plan = await client.syncPlanUpload({
    deviceId,
    storePath,
    objects: objectEntries,
  })
  if (verbose) {
    process.stdout.write(
      `plan ok • batchId=${plan.batchId} declaredObjects=${casObjects.length} missingObjects=${plan.missingObjectIds.length}\n`,
    )
  }

  const missingSet = new Set(plan.missingObjectIds)
  for (const { entry: obj, bytes } of casObjects) {
    if (!missingSet.has(obj.objectId)) continue
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
  }
  if (verbose && casObjects.length > 0) {
    process.stdout.write(`uploaded ${missingSet.size} CAS objects\n`)
  }

  const commit = await client.syncCommitUpload({
    batchId: plan.batchId,
    deviceId,
    storePath,
    objects: objectEntries,
    projection,
  })
  if (verbose) {
    process.stdout.write(`commit ok • objects=${commit.committedObjects} rows=${commit.committedRows}\n`)
  }

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
    declaredMessageIds: messages.map((m) => m.id),
    declaredContentBlockIds: contentBlocks.map((b) => b.id),
    declaredEventIds: events.map((e) => e.id),
    declaredArtifactIds: artifacts.map((a) => a.id),
  })

  return {
    batchId: plan.batchId,
    sessionCount: verify.receipt.sessionCount,
    objectCount: verify.receipt.objectCount,
    searchDocCount: verify.receipt.searchDocCount,
    receipt: verify.receipt,
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
