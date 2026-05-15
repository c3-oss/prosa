import type { CommitUploadInput, CommitUploadOutput, ObjectManifestEntry } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'
import { markBatchFailed, requireDeviceAccess, requireOpenBatchForCommit } from './batches.js'
import {
  assertObjectManifestsMatch,
  assertRemoteObjectCatalog,
  loadObjectManifest,
  requireStoredObject,
  storageKeyForObject,
  syncLimits,
  validateObjectManifest,
} from './manifest.js'
import { countProjectionRows, insertProjectionRows } from './projection-upserts.js'
import type { SyncHandlerContext } from './types.js'

async function insertRemoteObjectIfMissing(opts: {
  rawExec: RawExec
  object: ObjectManifestEntry
  storageKey: string
}): Promise<boolean> {
  const existing = await opts.rawExec('SELECT object_id FROM "remote_object" WHERE object_id = $1 LIMIT 1', [
    opts.object.objectId,
  ])
  if (existing.length > 0) return false
  await opts.rawExec(
    'INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key, content_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      opts.object.objectId,
      opts.object.hash,
      opts.object.hashAlgorithm,
      opts.object.compression,
      opts.object.uncompressedSize,
      opts.object.compressedSize,
      opts.storageKey,
      opts.object.contentType ?? null,
    ],
  )
  return true
}

async function attachTenantObject(opts: {
  rawExec: RawExec
  tenantId: string
  objectId: string
  batchId: string
}): Promise<void> {
  await opts.rawExec(
    `INSERT INTO "tenant_object"(tenant_id, object_id, first_batch_id, ref_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, object_id) DO NOTHING`,
    [opts.tenantId, opts.objectId, opts.batchId],
  )
}

export async function commitUpload(ctx: SyncHandlerContext, input: CommitUploadInput): Promise<CommitUploadOutput> {
  const committedRows = countProjectionRows(input.projection)
  if (committedRows > syncLimits.maxRowsPerCommit) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Commit exceeds maxRowsPerCommit limit' })
  }
  await requireDeviceAccess({
    rawExec: ctx.rawExec,
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    deviceId: input.deviceId,
    storePath: input.storePath,
  })
  const objects = input.objects.map(validateObjectManifest)

  let committedObjects = 0
  for (const obj of objects) {
    const storageKey = storageKeyForObject(obj)
    await requireStoredObject({ objectStore: ctx.objectStore, object: obj, storageKey })
  }

  let commitStarted = false
  try {
    await ctx.transaction(async (tx) => {
      await requireOpenBatchForCommit({
        rawExec: tx,
        batchId: input.batchId,
        tenantId: ctx.tenantId,
        deviceId: input.deviceId,
        userId: ctx.user.id,
        storePath: input.storePath,
      })

      const plannedObjects = await loadObjectManifest(tx, input.batchId, ctx.tenantId)
      assertObjectManifestsMatch(plannedObjects, objects)

      await tx('UPDATE "sync_batch" SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3', [
        'committing',
        input.batchId,
        ctx.tenantId,
      ])
      commitStarted = true

      for (const obj of objects) {
        const storageKey = storageKeyForObject(obj)
        await assertRemoteObjectCatalog({ rawExec: tx, object: obj, storageKey })
        if (await insertRemoteObjectIfMissing({ rawExec: tx, object: obj, storageKey })) {
          committedObjects += 1
        }
        await attachTenantObject({
          rawExec: tx,
          tenantId: ctx.tenantId,
          objectId: obj.objectId,
          batchId: input.batchId,
        })
      }

      await insertProjectionRows({
        rawExec: tx,
        tenantId: ctx.tenantId,
        batchId: input.batchId,
        projection: input.projection,
      })

      await tx(
        'UPDATE "sync_batch" SET status = $1, row_count = $2, object_count = $3, updated_at = now() WHERE id = $4 AND tenant_id = $5',
        ['committed', committedRows, objects.length, input.batchId, ctx.tenantId],
      )
    })
  } catch (error) {
    if (commitStarted) {
      await markBatchFailed(ctx.rawExec, input.batchId, ctx.tenantId, error)
    }
    throw error
  }

  return { batchId: input.batchId, committedObjects, committedRows }
}
