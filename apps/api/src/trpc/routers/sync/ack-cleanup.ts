import type { AckCleanupInput } from '@c3-oss/prosa-sync'
import { TRPCError } from '../../init.js'
import { requireVerifiedBatchForCleanup } from './batches.js'
import type { SyncHandlerContext } from './types.js'

export async function ackCleanup(
  ctx: SyncHandlerContext,
  input: AckCleanupInput,
): Promise<{ batchId: string; removed: number }> {
  await ctx.transaction(async (tx) => {
    const batch = await requireVerifiedBatchForCleanup({
      rawExec: tx,
      batchId: input.batchId,
      tenantId: ctx.tenantId,
      storePath: input.storePath,
    })
    const authority = await tx('SELECT 1 FROM "remote_authority" WHERE tenant_id = $1 AND store_path = $2 LIMIT 1', [
      ctx.tenantId,
      batch.store_path,
    ])
    if (!authority[0]) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Remote authority is missing for batch' })
    }
    await tx('UPDATE "remote_authority" SET cleanup_completed_at = now() WHERE tenant_id = $1 AND store_path = $2', [
      ctx.tenantId,
      batch.store_path,
    ])
    await tx(
      'UPDATE "sync_batch" SET cleanup_acknowledged_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2',
      [input.batchId, ctx.tenantId],
    )
  })
  return { batchId: input.batchId, removed: input.removedPaths.length }
}
