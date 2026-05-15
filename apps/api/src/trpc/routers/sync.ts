import { randomUUID } from 'node:crypto'
import {
  type CommitUploadOutput,
  type HandshakeOutput,
  PROTOCOL_VERSION,
  type PlanUploadOutput,
  type PromotionReceipt,
  type VerifyPromotionOutput,
  ackCleanupInputSchema,
  commitUploadInputSchema,
  handshakeInputSchema,
  planUploadInputSchema,
  verifyPromotionInputSchema,
} from '@c3-oss/prosa-sync'
import { z } from 'zod'
import type { RawExec } from '../../db.js'
import { readPackageVersion } from '../../version.js'
import { TRPCError, router, tenantProcedure } from '../init.js'

const limits = {
  maxObjectsPerPlan: 5000,
  maxRowsPerCommit: 10_000,
  maxObjectBytes: 256 * 1024 * 1024,
}

async function ensureDevice(opts: {
  rawExec: RawExec
  tenantId: string
  userId: string
  deviceName: string
  platform?: string
  cliVersion: string
  storePath: string
}): Promise<string> {
  const { rawExec, tenantId, userId, deviceName, platform, cliVersion, storePath } = opts
  const found = await rawExec<{ id: string }>(
    'SELECT id FROM "device" WHERE tenant_id = $1 AND user_id = $2 AND name = $3 LIMIT 1',
    [tenantId, userId, deviceName],
  )
  if (found[0]) {
    await rawExec(
      'UPDATE "device" SET last_seen_at = now(), platform = COALESCE($1, platform), cli_version = $2, store_path = $3 WHERE id = $4',
      [platform ?? null, cliVersion, storePath, found[0].id],
    )
    return found[0].id
  }
  const id = `dev_${randomUUID()}`
  await rawExec(
    'INSERT INTO "device"(id, tenant_id, user_id, name, platform, cli_version, store_path) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, tenantId, userId, deviceName, platform ?? null, cliVersion, storePath],
  )
  return id
}

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
      limits,
    }
  }),

  planUpload: tenantProcedure
    .input(planUploadInputSchema)
    .mutation(async ({ ctx, input }): Promise<PlanUploadOutput> => {
      if (input.objects.length > limits.maxObjectsPerPlan) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Too many objects in plan' })
      }
      const batchId = `batch_${randomUUID()}`
      await ctx.rawExec(
        'INSERT INTO "sync_batch"(id, tenant_id, device_id, user_id, status, object_count) VALUES ($1, $2, $3, $4, $5, $6)',
        [batchId, ctx.tenantId, input.deviceId, ctx.user.id, 'open', input.objects.length],
      )
      const missing: string[] = []
      for (const obj of input.objects) {
        const exists = await ctx.rawExec('SELECT 1 FROM "remote_object" WHERE object_id = $1 LIMIT 1', [obj.objectId])
        if (exists.length === 0) missing.push(obj.objectId)
      }
      return { batchId, missingObjectIds: missing, uploadUrlTemplate: '/objects/:objectId' }
    }),

  commitUpload: tenantProcedure
    .input(commitUploadInputSchema)
    .mutation(async ({ ctx, input }): Promise<CommitUploadOutput> => {
      const totalRows =
        input.projection.sourceFiles.length +
        input.projection.rawRecords.length +
        input.projection.sessions.length +
        input.projection.searchDocs.length
      if (totalRows > limits.maxRowsPerCommit) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Commit exceeds maxRowsPerCommit limit' })
      }

      const batchRows = await ctx.rawExec<{ id: string; status: string }>(
        'SELECT id, status FROM "sync_batch" WHERE id = $1 AND tenant_id = $2 LIMIT 1',
        [input.batchId, ctx.tenantId],
      )
      if (!batchRows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown batch' })
      }
      if (batchRows[0].status === 'committed' || batchRows[0].status === 'verified') {
        return { batchId: input.batchId, committedObjects: 0, committedRows: 0 }
      }

      let committedObjects = 0
      for (const obj of input.objects) {
        const existing = await ctx.rawExec('SELECT object_id FROM "remote_object" WHERE object_id = $1 LIMIT 1', [
          obj.objectId,
        ])
        if (existing.length === 0) {
          const ext = obj.compression === 'none' ? '.bin' : '.zst'
          await ctx.rawExec(
            'INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key, content_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              obj.objectId,
              obj.hash,
              obj.hashAlgorithm,
              obj.compression,
              obj.uncompressedSize,
              obj.compressedSize,
              `objects/blake3/${obj.hash.slice(0, 2)}/${obj.hash.slice(2, 4)}/${obj.hash}${ext}`,
              obj.contentType ?? null,
            ],
          )
          committedObjects += 1
        }
        await ctx.rawExec(
          `INSERT INTO "tenant_object"(tenant_id, object_id, first_batch_id, ref_count)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (tenant_id, object_id) DO UPDATE SET ref_count = "tenant_object".ref_count + 1`,
          [ctx.tenantId, obj.objectId, input.batchId],
        )
      }

      let committedRows = 0
      for (const session of input.projection.sessions) {
        await ctx.rawExec(
          `INSERT INTO "projection_session"(tenant_id, id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (tenant_id, id) DO NOTHING`,
          [
            ctx.tenantId,
            session.id,
            session.sourceKind,
            session.projectId ?? null,
            session.title ?? null,
            session.startedAt ?? null,
            session.endedAt ?? null,
            session.turnCount,
            session.metadata ? JSON.stringify(session.metadata) : null,
          ],
        )
        committedRows += 1
      }
      for (const sf of input.projection.sourceFiles) {
        await ctx.rawExec(
          `INSERT INTO "source_file"(tenant_id, id, source_kind, path, object_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (tenant_id, id) DO NOTHING`,
          [
            ctx.tenantId,
            sf.id,
            sf.sourceKind,
            sf.path,
            sf.objectId ?? null,
            sf.metadata ? JSON.stringify(sf.metadata) : null,
          ],
        )
        committedRows += 1
      }
      for (const rr of input.projection.rawRecords) {
        await ctx.rawExec(
          `INSERT INTO "raw_record"(tenant_id, id, source_file_id, sequence, payload, object_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (tenant_id, id) DO NOTHING`,
          [ctx.tenantId, rr.id, rr.sourceFileId, rr.sequence, JSON.stringify(rr.payload ?? null), rr.objectId ?? null],
        )
        committedRows += 1
      }
      for (const sd of input.projection.searchDocs) {
        await ctx.rawExec(
          `INSERT INTO "search_doc"(tenant_id, id, session_id, kind, body)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, id) DO NOTHING`,
          [ctx.tenantId, sd.id, sd.sessionId, sd.kind, sd.body],
        )
        committedRows += 1
      }

      await ctx.rawExec(
        'UPDATE "sync_batch" SET status = $1, row_count = $2, object_count = $3, updated_at = now() WHERE id = $4',
        ['committed', committedRows, input.objects.length, input.batchId],
      )

      return { batchId: input.batchId, committedObjects, committedRows }
    }),

  verifyPromotion: tenantProcedure
    .input(verifyPromotionInputSchema)
    .mutation(async ({ ctx, input }): Promise<VerifyPromotionOutput> => {
      const batchRows = await ctx.rawExec<{ id: string; device_id: string; status: string }>(
        'SELECT id, device_id, status FROM "sync_batch" WHERE id = $1 AND tenant_id = $2 LIMIT 1',
        [input.batchId, ctx.tenantId],
      )
      if (!batchRows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown batch' })
      }
      if (batchRows[0].status !== 'committed' && batchRows[0].status !== 'verified') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Batch must be committed before verification',
        })
      }

      // 1. Verify every declared object id has a tenant_object provenance row.
      let declaredObjectsVerified = 0
      const missingObjects: string[] = []
      if (input.declaredObjectIds.length > 0) {
        const found = await ctx.rawExec<{ object_id: string }>(
          `SELECT object_id FROM "tenant_object" WHERE tenant_id = $1 AND object_id = ANY($2::text[])`,
          [ctx.tenantId, input.declaredObjectIds],
        )
        const have = new Set(found.map((r) => r.object_id))
        declaredObjectsVerified = have.size
        for (const id of input.declaredObjectIds) {
          if (!have.has(id)) missingObjects.push(id)
        }
      }

      // 2. Verify every declared session is queryable.
      let declaredSessionsVerified = 0
      const missingSessions: string[] = []
      if (input.declaredSessionIds.length > 0) {
        const found = await ctx.rawExec<{ id: string }>(
          `SELECT id FROM "projection_session" WHERE tenant_id = $1 AND id = ANY($2::text[])`,
          [ctx.tenantId, input.declaredSessionIds],
        )
        const have = new Set(found.map((r) => r.id))
        declaredSessionsVerified = have.size
        for (const id of input.declaredSessionIds) {
          if (!have.has(id)) missingSessions.push(id)
        }
      }

      // 3. Verify every declared search doc is queryable.
      let declaredSearchDocsVerified = 0
      const missingSearchDocs: string[] = []
      if (input.declaredSearchDocIds.length > 0) {
        const found = await ctx.rawExec<{ id: string }>(
          `SELECT id FROM "search_doc" WHERE tenant_id = $1 AND id = ANY($2::text[])`,
          [ctx.tenantId, input.declaredSearchDocIds],
        )
        const have = new Set(found.map((r) => r.id))
        declaredSearchDocsVerified = have.size
        for (const id of input.declaredSearchDocIds) {
          if (!have.has(id)) missingSearchDocs.push(id)
        }
      }

      // Fail-closed: any missing declaration blocks the receipt. The CLI is
      // expected to retry the upload before invoking cleanup.
      if (missingObjects.length > 0 || missingSessions.length > 0 || missingSearchDocs.length > 0) {
        await ctx.rawExec('UPDATE "sync_batch" SET status = $1, error = $2::jsonb, updated_at = now() WHERE id = $3', [
          'verification_failed',
          JSON.stringify({ missingObjects, missingSessions, missingSearchDocs }),
          input.batchId,
        ])
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Promotion verification failed: missing ${missingObjects.length} objects, ${missingSessions.length} sessions, ${missingSearchDocs.length} search docs.`,
        })
      }

      // 4. Aggregate tenant-scoped counts for the receipt and confirm a
      //    smoke-test read works: the sessions sample query exercises the
      //    same code path the server-side reads use.
      const counts = await ctx.rawExec<{ sessions: number; objects: number; docs: number }>(
        `SELECT
            (SELECT count(*)::int FROM "projection_session" WHERE tenant_id = $1) as sessions,
            (SELECT count(*)::int FROM "tenant_object" WHERE tenant_id = $1) as objects,
            (SELECT count(*)::int FROM "search_doc" WHERE tenant_id = $1) as docs`,
        [ctx.tenantId],
      )
      const sampledRows = await ctx.rawExec<{ id: string; title: string | null; turn_count: number }>(
        'SELECT id, title, turn_count FROM "projection_session" WHERE tenant_id = $1 ORDER BY id LIMIT 5',
        [ctx.tenantId],
      )

      const receipt: PromotionReceipt = {
        batchId: input.batchId,
        tenantId: ctx.tenantId,
        deviceId: batchRows[0].device_id,
        storePath: input.storePath,
        sessionCount: counts[0]?.sessions ?? 0,
        objectCount: counts[0]?.objects ?? 0,
        searchDocCount: counts[0]?.docs ?? 0,
        declaredObjectsVerified,
        declaredSessionsVerified,
        declaredSearchDocsVerified,
        verifiedAt: new Date().toISOString(),
      }

      await ctx.rawExec(
        'UPDATE "sync_batch" SET status = $1, promotion_receipt = $2::jsonb, error = NULL, updated_at = now() WHERE id = $3',
        ['verified', JSON.stringify(receipt), input.batchId],
      )
      await ctx.rawExec(
        `INSERT INTO "remote_authority"(tenant_id, device_id, store_path, promotion_receipt)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id, store_path) DO UPDATE SET promotion_receipt = EXCLUDED.promotion_receipt, promoted_at = now()`,
        [ctx.tenantId, batchRows[0].device_id, input.storePath, JSON.stringify(receipt)],
      )

      return {
        receipt,
        sampledSessions: sampledRows.map((row) => ({
          id: row.id,
          title: row.title,
          turnCount: row.turn_count,
        })),
      }
    }),

  ackCleanup: tenantProcedure.input(ackCleanupInputSchema).mutation(async ({ ctx, input }) => {
    await ctx.rawExec(
      'UPDATE "remote_authority" SET cleanup_completed_at = now() WHERE tenant_id = $1 AND store_path = $2',
      [ctx.tenantId, input.storePath],
    )
    await ctx.rawExec(
      'UPDATE "sync_batch" SET cleanup_acknowledged_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2',
      [input.batchId, ctx.tenantId],
    )
    return { batchId: input.batchId, removed: input.removedPaths.length }
  }),

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
