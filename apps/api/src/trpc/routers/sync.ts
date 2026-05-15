import {
  type CommitUploadOutput,
  type HandshakeOutput,
  PROTOCOL_VERSION,
  type PlanUploadOutput,
  type VerifyPromotionOutput,
  ackCleanupInputSchema,
  commitUploadInputSchema,
  handshakeInputSchema,
  planUploadInputSchema,
  verifyPromotionInputSchema,
} from '@c3-oss/prosa-sync'
import { z } from 'zod'
import { readPackageVersion } from '../../version.js'
import { router, tenantProcedure } from '../init.js'
import { ackCleanup } from './sync/ack-cleanup.js'
import { ensureDevice } from './sync/batches.js'
import { commitUpload } from './sync/commit-upload.js'
import { syncLimits } from './sync/manifest.js'
import { planUpload } from './sync/plan-upload.js'
import { verifyPromotion } from './sync/verify-promotion.js'

export const syncRouter = router({
  handshake: tenantProcedure.input(handshakeInputSchema).mutation(async ({ ctx, input }): Promise<HandshakeOutput> => {
    const deviceId = await ensureDevice({
      rawExec: ctx.rawExec,
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      deviceName: input.device.name,
      platform: input.device.platform,
      cliVersion: input.cliVersion,
      storePath: input.store.path,
    })
    const promoted = await ctx.rawExec(
      'SELECT 1 FROM "remote_authority" WHERE tenant_id = $1 AND store_path = $2 LIMIT 1',
      [ctx.tenantId, input.store.path],
    )
    return {
      serverVersion: readPackageVersion(),
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      promoted: promoted.length > 0,
      limits: syncLimits,
    }
  }),

  planUpload: tenantProcedure
    .input(planUploadInputSchema)
    .mutation(async ({ ctx, input }): Promise<PlanUploadOutput> => planUpload(ctx, input)),

  commitUpload: tenantProcedure
    .input(commitUploadInputSchema)
    .mutation(async ({ ctx, input }): Promise<CommitUploadOutput> => commitUpload(ctx, input)),

  verifyPromotion: tenantProcedure
    .input(verifyPromotionInputSchema)
    .mutation(async ({ ctx, input }): Promise<VerifyPromotionOutput> => verifyPromotion(ctx, input)),

  ackCleanup: tenantProcedure.input(ackCleanupInputSchema).mutation(async ({ ctx, input }) => ackCleanup(ctx, input)),

  status: tenantProcedure
    .input(z.object({ storePath: z.string().min(1).optional() }).optional())
    .query(async ({ ctx, input }) => {
      if (input?.storePath) {
        const rows = await ctx.rawExec(
          'SELECT store_path, promotion_receipt, promoted_at, cleanup_completed_at FROM "remote_authority" WHERE tenant_id = $1 AND store_path = $2 LIMIT 1',
          [ctx.tenantId, input.storePath],
        )
        return { authorities: rows }
      }
      const rows = await ctx.rawExec(
        'SELECT store_path, promoted_at, cleanup_completed_at FROM "remote_authority" WHERE tenant_id = $1 ORDER BY promoted_at DESC LIMIT 20',
        [ctx.tenantId],
      )
      return { authorities: rows }
    }),
})
