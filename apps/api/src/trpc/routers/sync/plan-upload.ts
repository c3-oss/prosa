import { randomUUID } from 'node:crypto'
import type { PlanUploadInput, PlanUploadOutput } from '@c3-oss/prosa-sync'
import { TRPCError } from '../../init.js'
import { requireDeviceAccess } from './batches.js'
import {
  assertRemoteObjectCatalog,
  findMissingObjectIds,
  storageKeyForObject,
  syncLimits,
  validateObjectManifest,
} from './manifest.js'
import type { SyncHandlerContext } from './types.js'

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
  const batchId = `batch_${randomUUID()}`
  await ctx.transaction(async (tx) => {
    await tx(
      'INSERT INTO "sync_batch"(id, tenant_id, device_id, user_id, store_path, status, object_count) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [batchId, ctx.tenantId, input.deviceId, ctx.user.id, input.storePath, 'open', objects.length],
    )
    for (const obj of objects) {
      const storageKey = storageKeyForObject(obj)
      await assertRemoteObjectCatalog({ rawExec: tx, object: obj, storageKey })
      await tx(
        `INSERT INTO "sync_batch_object_manifest"(
           batch_id, tenant_id, object_id, canonical_hash, transport_hash, compression,
           uncompressed_size, compressed_size, storage_key, content_type
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          batchId,
          ctx.tenantId,
          obj.objectId,
          obj.hash,
          obj.transportHash ?? obj.hash,
          obj.compression,
          obj.uncompressedSize,
          obj.compressedSize,
          storageKey,
          obj.contentType ?? null,
        ],
      )
    }
  })
  const missingObjectIds = await findMissingObjectIds({
    rawExec: ctx.rawExec,
    objectStore: ctx.objectStore,
    objects,
  })
  return { batchId, missingObjectIds, uploadUrlTemplate: '/objects/:objectId' }
}
