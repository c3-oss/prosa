import type { PromotionReceipt, VerifyPromotionInput, VerifyPromotionOutput } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'
import { type VerificationBatchRow, markBatchFailed, requireCommittedBatchForVerification } from './batches.js'
import {
  type BatchObjectManifestRow,
  type ProjectionManifestRow,
  assertSameDeclarationSet,
  buildManifestHash,
  loadObjectManifest,
  objectFromManifestRow,
} from './manifest.js'
import type { SyncHandlerContext } from './types.js'

type ProjectionManifestByType = {
  source_file: string[]
  raw_record: string[]
  session: string[]
  search_doc: string[]
  tool_call: string[]
  tool_result: string[]
}

type VerifiedProjectionCounts = {
  sourceFiles: number
  rawRecords: number
  sessions: number
  searchDocs: number
  toolCalls: number
  toolResults: number
}

function groupProjectionManifest(rows: ProjectionManifestRow[]): ProjectionManifestByType {
  return {
    source_file: rows.filter((row) => row.entity_type === 'source_file').map((row) => row.entity_id),
    raw_record: rows.filter((row) => row.entity_type === 'raw_record').map((row) => row.entity_id),
    session: rows.filter((row) => row.entity_type === 'session').map((row) => row.entity_id),
    search_doc: rows.filter((row) => row.entity_type === 'search_doc').map((row) => row.entity_id),
    tool_call: rows.filter((row) => row.entity_type === 'tool_call').map((row) => row.entity_id),
    tool_result: rows.filter((row) => row.entity_type === 'tool_result').map((row) => row.entity_id),
  }
}

function assertDeclaredManifestMatches(
  input: VerifyPromotionInput,
  objectManifest: BatchObjectManifestRow[],
  projection: ProjectionManifestByType,
): void {
  assertSameDeclarationSet(
    'object',
    input.declaredObjectIds,
    objectManifest.map((row) => row.object_id),
  )
  assertSameDeclarationSet('source file', input.declaredSourceFileIds, projection.source_file)
  assertSameDeclarationSet('raw record', input.declaredRawRecordIds, projection.raw_record)
  assertSameDeclarationSet('session', input.declaredSessionIds, projection.session)
  assertSameDeclarationSet('search doc', input.declaredSearchDocIds, projection.search_doc)
  assertSameDeclarationSet('tool call', input.declaredToolCallIds, projection.tool_call)
  assertSameDeclarationSet('tool result', input.declaredToolResultIds, projection.tool_result)
}

async function loadProjectionManifest(
  rawExec: RawExec,
  batchId: string,
  tenantId: string,
): Promise<ProjectionManifestRow[]> {
  return rawExec<ProjectionManifestRow>(
    `SELECT entity_type, entity_id
       FROM "sync_batch_projection_manifest"
       WHERE batch_id = $1 AND tenant_id = $2
       ORDER BY entity_type, entity_id`,
    [batchId, tenantId],
  )
}

async function verifyObjectManifest(opts: {
  rawExec: RawExec
  objectStore: SyncHandlerContext['objectStore']
  tenantId: string
  objectManifest: BatchObjectManifestRow[]
}): Promise<void> {
  for (const row of opts.objectManifest) {
    const object = objectFromManifestRow(row)
    const found = await opts.rawExec<{ object_id: string }>(
      'SELECT object_id FROM "tenant_object" WHERE tenant_id = $1 AND object_id = $2 LIMIT 1',
      [opts.tenantId, row.object_id],
    )
    const head = await opts.objectStore.head(row.storage_key)
    if (
      !found[0] ||
      !head ||
      head.hash.toLowerCase() !== object.transportHash ||
      head.compressedSize !== object.compressedSize ||
      head.uncompressedSize !== object.uncompressedSize
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Promotion verification failed: object ${row.object_id} is missing or mismatched`,
      })
    }
  }
}

async function countProjectionRows(opts: {
  rawExec: RawExec
  tenantId: string
  projection: ProjectionManifestByType
}): Promise<VerifiedProjectionCounts> {
  const sourceFilesFound = await opts.rawExec<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM "source_file"
       WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, opts.projection.source_file],
  )
  const rawRecordsFound = await opts.rawExec<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM "raw_record"
       WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, opts.projection.raw_record],
  )
  const sessionsFound = await opts.rawExec<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM "projection_session"
       WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, opts.projection.session],
  )
  const searchDocsFound = await opts.rawExec<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM "search_doc"
       WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, opts.projection.search_doc],
  )
  const toolCallsFound = await opts.rawExec<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM "projection_tool_call"
       WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, opts.projection.tool_call],
  )
  const toolResultsFound = await opts.rawExec<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM "projection_tool_result"
       WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, opts.projection.tool_result],
  )
  return {
    sourceFiles: sourceFilesFound[0]?.count ?? 0,
    rawRecords: rawRecordsFound[0]?.count ?? 0,
    sessions: sessionsFound[0]?.count ?? 0,
    searchDocs: searchDocsFound[0]?.count ?? 0,
    toolCalls: toolCallsFound[0]?.count ?? 0,
    toolResults: toolResultsFound[0]?.count ?? 0,
  }
}

function assertProjectionRowsExist(projection: ProjectionManifestByType, counts: VerifiedProjectionCounts): void {
  if (
    counts.sourceFiles !== projection.source_file.length ||
    counts.rawRecords !== projection.raw_record.length ||
    counts.sessions !== projection.session.length ||
    counts.searchDocs !== projection.search_doc.length ||
    counts.toolCalls !== projection.tool_call.length ||
    counts.toolResults !== projection.tool_result.length
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Promotion verification failed: projection rows are missing',
    })
  }
}

async function sampleSessions(opts: {
  rawExec: RawExec
  tenantId: string
  input: VerifyPromotionInput
  projection: ProjectionManifestByType
}): Promise<Array<{ id: string; title: string | null; turnCount: number }>> {
  const sampleIds =
    opts.input.sampleSessionIds.length > 0
      ? opts.input.sampleSessionIds.filter((id) => opts.projection.session.includes(id))
      : opts.projection.session.slice(0, 5)
  const rows = await opts.rawExec<{ id: string; title: string | null; turn_count: number }>(
    `SELECT id, title, turn_count
       FROM "projection_session"
       WHERE tenant_id = $1 AND id = ANY($2::text[])
       ORDER BY id
       LIMIT 5`,
    [opts.tenantId, sampleIds],
  )
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    turnCount: row.turn_count,
  }))
}

function buildPromotionReceipt(opts: {
  batchId: string
  tenantId: string
  batch: VerificationBatchRow
  objectManifest: BatchObjectManifestRow[]
  projectionManifest: ProjectionManifestRow[]
  projection: ProjectionManifestByType
  counts: VerifiedProjectionCounts
}): PromotionReceipt {
  return {
    batchId: opts.batchId,
    tenantId: opts.tenantId,
    deviceId: opts.batch.device_id,
    storePath: opts.batch.store_path,
    manifestHash: buildManifestHash({ objects: opts.objectManifest, projection: opts.projectionManifest }),
    sessionCount: opts.projection.session.length,
    objectCount: opts.objectManifest.length,
    searchDocCount: opts.projection.search_doc.length,
    batchObjectCount: opts.objectManifest.length,
    batchSourceFileCount: opts.projection.source_file.length,
    batchRawRecordCount: opts.projection.raw_record.length,
    batchSessionCount: opts.projection.session.length,
    batchSearchDocCount: opts.projection.search_doc.length,
    batchToolCallCount: opts.projection.tool_call.length,
    batchToolResultCount: opts.projection.tool_result.length,
    declaredObjectsVerified: opts.objectManifest.length,
    declaredSourceFilesVerified: opts.counts.sourceFiles,
    declaredRawRecordsVerified: opts.counts.rawRecords,
    declaredSessionsVerified: opts.counts.sessions,
    declaredSearchDocsVerified: opts.counts.searchDocs,
    declaredToolCallsVerified: opts.counts.toolCalls,
    declaredToolResultsVerified: opts.counts.toolResults,
    cleanupEligible: true,
    verifiedAt: new Date().toISOString(),
  }
}

async function savePromotionReceipt(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  batch: VerificationBatchRow
  receipt: PromotionReceipt
}): Promise<void> {
  await opts.rawExec(
    'UPDATE "sync_batch" SET status = $1, promotion_receipt = $2::jsonb, error = NULL, updated_at = now() WHERE id = $3 AND tenant_id = $4',
    ['verified', JSON.stringify(opts.receipt), opts.batchId, opts.tenantId],
  )
  await opts.rawExec(
    `INSERT INTO "remote_authority"(tenant_id, device_id, store_path, promotion_receipt)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, store_path) DO UPDATE SET promotion_receipt = EXCLUDED.promotion_receipt, promoted_at = now()`,
    [opts.tenantId, opts.batch.device_id, opts.batch.store_path, JSON.stringify(opts.receipt)],
  )
}

export async function verifyPromotion(
  ctx: SyncHandlerContext,
  input: VerifyPromotionInput,
): Promise<VerifyPromotionOutput> {
  let verificationStarted = false
  try {
    return await ctx.transaction(async (tx) => {
      const batch = await requireCommittedBatchForVerification({
        rawExec: tx,
        batchId: input.batchId,
        tenantId: ctx.tenantId,
        userId: ctx.user.id,
        storePath: input.storePath,
      })

      await tx('UPDATE "sync_batch" SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3', [
        'verifying',
        input.batchId,
        ctx.tenantId,
      ])
      verificationStarted = true

      const objectManifest = await loadObjectManifest(tx, input.batchId, ctx.tenantId)
      const projectionManifest = await loadProjectionManifest(tx, input.batchId, ctx.tenantId)
      const projection = groupProjectionManifest(projectionManifest)

      assertDeclaredManifestMatches(input, objectManifest, projection)
      await verifyObjectManifest({
        rawExec: tx,
        objectStore: ctx.objectStore,
        tenantId: ctx.tenantId,
        objectManifest,
      })

      const counts = await countProjectionRows({ rawExec: tx, tenantId: ctx.tenantId, projection })
      assertProjectionRowsExist(projection, counts)

      const sampledSessions = await sampleSessions({ rawExec: tx, tenantId: ctx.tenantId, input, projection })
      const receipt = buildPromotionReceipt({
        batchId: input.batchId,
        tenantId: ctx.tenantId,
        batch,
        objectManifest,
        projectionManifest,
        projection,
        counts,
      })

      await savePromotionReceipt({ rawExec: tx, tenantId: ctx.tenantId, batchId: input.batchId, batch, receipt })

      return { receipt, sampledSessions }
    })
  } catch (error) {
    if (verificationStarted) {
      await markBatchFailed(ctx.rawExec, input.batchId, ctx.tenantId, error)
    }
    throw error
  }
}
