import { randomUUID } from 'node:crypto'
import type { PlanUploadInput, PlanUploadOutput } from '@c3-oss/prosa-sync'
import { TRPCError } from '../../init.js'
import { requireDeviceAccess } from './batches.js'
import {
  assertRemoteObjectCatalogs,
  assertUniqueObjectIds,
  findMissingObjectIds,
  storageKeyForObject,
  syncLimits,
  validateObjectManifest,
} from './manifest.js'
import type { SyncHandlerContext } from './types.js'

async function insertObjectManifestBulk(opts: {
  rawExec: SyncHandlerContext['rawExec']
  tenantId: string
  batchId: string
  objects: ReturnType<typeof validateObjectManifest>[]
}): Promise<void> {
  if (opts.objects.length === 0) return
  await opts.rawExec(
    `INSERT INTO "sync_batch_object_manifest"(
       batch_id, tenant_id, object_id, canonical_hash, transport_hash, compression,
       uncompressed_size, compressed_size, storage_key, content_type
     )
     SELECT $1, $2, input.object_id, input.canonical_hash, input.transport_hash,
            input.compression, input.uncompressed_size, input.compressed_size,
            input.storage_key, input.content_type
       FROM unnest(
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::bigint[],
         $8::bigint[],
         $9::text[],
         $10::text[]
       ) AS input(
         object_id, canonical_hash, transport_hash, compression,
         uncompressed_size, compressed_size, storage_key, content_type
       )`,
    [
      opts.batchId,
      opts.tenantId,
      opts.objects.map((object) => object.objectId),
      opts.objects.map((object) => object.hash),
      opts.objects.map((object) => object.transportHash ?? object.hash),
      opts.objects.map((object) => object.compression),
      opts.objects.map((object) => object.uncompressedSize),
      opts.objects.map((object) => object.compressedSize),
      opts.objects.map((object) => storageKeyForObject(object)),
      opts.objects.map((object) => object.contentType ?? null),
    ],
  )
}

export async function planUpload(ctx: SyncHandlerContext, input: PlanUploadInput): Promise<PlanUploadOutput> {
  if (input.objects.length > syncLimits.maxObjectsPerPlan) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Too many objects in plan' })
  }
  await requireDeviceAccess({
    rawExec: ctx.rawExec,
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    deviceId: input.deviceId,
  })
  const objects = input.objects.map(validateObjectManifest)
  assertUniqueObjectIds(objects)
  const batchId = `batch_${randomUUID()}`
  await ctx.transaction(async (tx) => {
    await tx(
      'INSERT INTO "sync_batch"(id, tenant_id, device_id, user_id, store_path, status, object_count) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [batchId, ctx.tenantId, input.deviceId, ctx.user.id, input.storePath, 'open', objects.length],
    )
    await assertRemoteObjectCatalogs({ rawExec: tx, objects })
    await insertObjectManifestBulk({ rawExec: tx, tenantId: ctx.tenantId, batchId, objects })
  })
  const missingObjectIds = await findMissingObjectIds({
    rawExec: ctx.rawExec,
    objectStore: ctx.objectStore,
    objects,
  })
  return { batchId, missingObjectIds, uploadUrlTemplate: '/objects/:objectId' }
}
