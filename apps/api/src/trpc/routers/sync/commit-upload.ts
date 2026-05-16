import type { CommitUploadInput, CommitUploadOutput, ObjectManifestEntry } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'
import { markBatchFailed, requireDeviceAccess, requireOpenBatchForCommit } from './batches.js'
import {
  assertObjectManifestsMatch,
  assertRemoteObjectCatalogs,
  assertUniqueObjectIds,
  loadObjectManifest,
  mapWithConcurrency,
  objectStoreIoConcurrency,
  requireStoredObject,
  storageKeyForObject,
  syncLimits,
  validateObjectManifest,
} from './manifest.js'
import { countProjectionRows, insertProjectionRows } from './projection-upserts.js'
import type { SyncHandlerContext } from './types.js'

async function insertRemoteObjectIfMissing(opts: {
  rawExec: RawExec
  objects: ObjectManifestEntry[]
}): Promise<number> {
  if (opts.objects.length === 0) return 0
  const rows = await opts.rawExec<{ object_id: string }>(
    `INSERT INTO "remote_object"(
       object_id, hash, hash_algorithm, compression, uncompressed_size,
       compressed_size, storage_key, content_type
     )
     SELECT input.object_id, input.hash, input.hash_algorithm, input.compression,
            input.uncompressed_size, input.compressed_size, input.storage_key,
            input.content_type
       FROM unnest(
         $1::text[],
         $2::text[],
         $3::text[],
         $4::text[],
         $5::bigint[],
         $6::bigint[],
         $7::text[],
         $8::text[]
       ) AS input(
         object_id, hash, hash_algorithm, compression, uncompressed_size,
         compressed_size, storage_key, content_type
       )
     ON CONFLICT (object_id) DO NOTHING
     RETURNING object_id`,
    [
      opts.objects.map((object) => object.objectId),
      opts.objects.map((object) => object.hash),
      opts.objects.map((object) => object.hashAlgorithm),
      opts.objects.map((object) => object.compression),
      opts.objects.map((object) => object.uncompressedSize),
      opts.objects.map((object) => object.compressedSize),
      opts.objects.map((object) => storageKeyForObject(object)),
      opts.objects.map((object) => object.contentType ?? null),
    ],
  )
  return rows.length
}

async function attachTenantObjects(opts: {
  rawExec: RawExec
  tenantId: string
  objects: ObjectManifestEntry[]
  batchId: string
}): Promise<void> {
  if (opts.objects.length === 0) return
  await opts.rawExec(
    `INSERT INTO "tenant_object"(tenant_id, object_id, first_batch_id, ref_count)
     SELECT $1, object_id, $2, 1
       FROM unnest($3::text[]) AS input(object_id)
     ON CONFLICT (tenant_id, object_id) DO NOTHING`,
    [opts.tenantId, opts.batchId, opts.objects.map((object) => object.objectId)],
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
  })
  const objects = input.objects.map(validateObjectManifest)
  assertUniqueObjectIds(objects)

  await mapWithConcurrency(objects, objectStoreIoConcurrency, async (object) =>
    requireStoredObject({ objectStore: ctx.objectStore, object, storageKey: storageKeyForObject(object) }),
  )

  let committedObjects = 0
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

      await assertRemoteObjectCatalogs({ rawExec: tx, objects })
      committedObjects = await insertRemoteObjectIfMissing({ rawExec: tx, objects })
      await attachTenantObjects({ rawExec: tx, tenantId: ctx.tenantId, objects, batchId: input.batchId })

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
