import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { PromotionReceipt } from '@c3-oss/prosa-sync'
import type { ProsaApiClient } from '../auth/client.js'
import type { LocalBundleUpload, LocalCasObject } from './bundle.js'

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
  maxObjectPackBytes?: number
  verbose?: boolean
}

export type MissingObjectUploadStats = {
  packedObjectCount: number
  packCount: number
  putObjectCount: number
}

const BLAKE3_HEX_RE = /^[0-9a-f]{64}$/i
const OBJECT_PACK_ENTRY_LIMIT = 1024
const DEFAULT_OBJECT_PACK_MAX_BYTES = 8 * 1024 * 1024

function isSafePackObject({ entry, bytes }: LocalCasObject, maxObjectPackBytes: number): boolean {
  const hash = entry.hash.toLowerCase()
  const transportHash = (entry.transportHash ?? entry.hash).toLowerCase()
  return (
    entry.hashAlgorithm === 'blake3' &&
    BLAKE3_HEX_RE.test(hash) &&
    BLAKE3_HEX_RE.test(transportHash) &&
    entry.objectId === `blake3:${hash}` &&
    (entry.compression === 'zstd' || entry.compression === 'none') &&
    Number.isSafeInteger(entry.compressedSize) &&
    Number.isSafeInteger(entry.uncompressedSize) &&
    entry.compressedSize >= 0 &&
    entry.uncompressedSize >= 0 &&
    entry.compressedSize === bytes.byteLength &&
    entry.compressedSize <= maxObjectPackBytes &&
    entry.uncompressedSize <= maxObjectPackBytes
  )
}

export function splitMissingObjectUploads(
  missingObjects: LocalCasObject[],
  maxObjectPackBytes: number = DEFAULT_OBJECT_PACK_MAX_BYTES,
): { packs: LocalCasObject[][]; putObjects: LocalCasObject[] } {
  const packs: LocalCasObject[][] = []
  const putObjects: LocalCasObject[] = []
  let current: LocalCasObject[] = []
  let currentCompressedSize = 0
  let currentUncompressedSize = 0

  for (const object of missingObjects) {
    if (!isSafePackObject(object, maxObjectPackBytes)) {
      putObjects.push(object)
      continue
    }

    const nextCompressedSize = currentCompressedSize + object.entry.compressedSize
    const nextUncompressedSize = currentUncompressedSize + object.entry.uncompressedSize
    if (
      current.length >= OBJECT_PACK_ENTRY_LIMIT ||
      nextCompressedSize > maxObjectPackBytes ||
      nextUncompressedSize > maxObjectPackBytes
    ) {
      if (current.length > 0) packs.push(current)
      current = []
      currentCompressedSize = 0
      currentUncompressedSize = 0
    }

    current.push(object)
    currentCompressedSize += object.entry.compressedSize
    currentUncompressedSize += object.entry.uncompressedSize
  }

  if (current.length > 0) packs.push(current)
  return { packs, putObjects }
}

async function uploadObjectPut(client: ProsaApiClient, batchId: string, { entry: obj, bytes }: LocalCasObject) {
  await client.uploadObjectBytes({
    batchId,
    objectId: obj.objectId,
    hash: obj.hash,
    ...(obj.transportHash ? { transportHash: obj.transportHash } : {}),
    compression: obj.compression,
    compressedSize: obj.compressedSize,
    uncompressedSize: obj.uncompressedSize,
    bytes,
  })
}

export async function uploadMissingCasObjects({
  client,
  batchId,
  missingObjects,
  maxObjectPackBytes = DEFAULT_OBJECT_PACK_MAX_BYTES,
}: {
  client: ProsaApiClient
  batchId: string
  missingObjects: LocalCasObject[]
  maxObjectPackBytes?: number
}): Promise<MissingObjectUploadStats> {
  const { packs, putObjects } = splitMissingObjectUploads(missingObjects, maxObjectPackBytes)
  for (const pack of packs) {
    await client.uploadObjectPack({
      batchId,
      objects: pack.map(({ entry, bytes }) => ({ ...entry, bytes })),
    })
  }
  for (const object of putObjects) {
    await uploadObjectPut(client, batchId, object)
  }
  return {
    packedObjectCount: packs.reduce((sum, pack) => sum + pack.length, 0),
    packCount: packs.length,
    putObjectCount: putObjects.length,
  }
}

export async function promoteUpload({
  client,
  deviceId,
  storePath,
  upload,
  maxObjectPackBytes,
  verbose,
}: PromoteUploadOptions): Promise<SyncPromotionResult> {
  const { casObjects, projection, rawRecords, searchDocs, sessions, sourceFiles, toolCalls, toolResults } = upload
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
  const missingObjects = casObjects.filter(({ entry }) => missingSet.has(entry.objectId))
  const uploadStats = await uploadMissingCasObjects({
    client,
    batchId: plan.batchId,
    missingObjects,
    ...(maxObjectPackBytes ? { maxObjectPackBytes } : {}),
  })
  if (verbose && casObjects.length > 0) {
    process.stdout.write(
      `uploaded ${missingSet.size} CAS objects (${uploadStats.packedObjectCount} packed in ${uploadStats.packCount} pack(s), ${uploadStats.putObjectCount} via PUT)\n`,
    )
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
