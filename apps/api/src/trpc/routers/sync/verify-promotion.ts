import type { PromotionReceipt, VerifyPromotionInput, VerifyPromotionOutput } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'
import { type VerificationBatchRow, markBatchFailed } from './batches.js'
import {
  type BatchObjectManifestRow,
  type ProjectionManifestRow,
  assertSameDeclarationSet,
  buildManifestHash,
  loadObjectManifest,
  mapWithConcurrency,
  objectFromManifestRow,
  objectStoreHeadMatches,
  objectStoreIoConcurrency,
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

async function requireBatchForVerification(opts: {
  rawExec: RawExec
  batchId: string
  tenantId: string
  userId: string
  storePath: string
}): Promise<VerificationBatchRow> {
  const rows = await opts.rawExec<VerificationBatchRow>(
    'SELECT id, device_id, status, user_id, store_path FROM "sync_batch" WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE',
    [opts.batchId, opts.tenantId, opts.userId],
  )
  const batch = rows[0]
  if (!batch) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown batch' })
  }
  if (batch.store_path !== opts.storePath) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch storePath mismatch' })
  }
  if (batch.status !== 'committed' && batch.status !== 'verifying') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Batch must be committed before verification',
    })
  }
  return batch
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
  if (opts.objectManifest.length === 0) return
  const foundRows = await opts.rawExec<{ object_id: string }>(
    `SELECT object_id
       FROM "tenant_object"
       WHERE tenant_id = $1 AND object_id = ANY($2::text[])`,
    [opts.tenantId, opts.objectManifest.map((row) => row.object_id)],
  )
  const foundObjectIds = new Set(foundRows.map((row) => row.object_id))
  const headResults = await mapWithConcurrency(opts.objectManifest, objectStoreIoConcurrency, async (row) => {
    const object = objectFromManifestRow(row)
    return {
      objectId: row.object_id,
      matches: objectStoreHeadMatches(await opts.objectStore.head(row.storage_key), object),
    }
  })
  const matchingHeads = new Set(headResults.filter((result) => result.matches).map((result) => result.objectId))
  for (const row of opts.objectManifest) {
    if (!foundObjectIds.has(row.object_id) || !matchingHeads.has(row.object_id)) {
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
  const rows = await opts.rawExec<{
    source_files: number
    raw_records: number
    sessions: number
    search_docs: number
    tool_calls: number
    tool_results: number
  }>(
    `SELECT
       (SELECT count(*)::int FROM "source_file"
         WHERE tenant_id = $1 AND id = ANY($2::text[])) AS source_files,
       (SELECT count(*)::int FROM "raw_record"
         WHERE tenant_id = $1 AND id = ANY($3::text[])) AS raw_records,
       (SELECT count(*)::int FROM "projection_session"
         WHERE tenant_id = $1 AND id = ANY($4::text[])) AS sessions,
       (SELECT count(*)::int FROM "search_doc"
         WHERE tenant_id = $1 AND id = ANY($5::text[])) AS search_docs,
       (SELECT count(*)::int FROM "projection_tool_call"
         WHERE tenant_id = $1 AND id = ANY($6::text[])) AS tool_calls,
       (SELECT count(*)::int FROM "projection_tool_result"
         WHERE tenant_id = $1 AND id = ANY($7::text[])) AS tool_results`,
    [
      opts.tenantId,
      opts.projection.source_file,
      opts.projection.raw_record,
      opts.projection.session,
      opts.projection.search_doc,
      opts.projection.tool_call,
      opts.projection.tool_result,
    ],
  )
  const row = rows[0]
  return {
    sourceFiles: row?.source_files ?? 0,
    rawRecords: row?.raw_records ?? 0,
    sessions: row?.sessions ?? 0,
    searchDocs: row?.search_docs ?? 0,
    toolCalls: row?.tool_calls ?? 0,
    toolResults: row?.tool_results ?? 0,
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
  let batch: VerificationBatchRow
  let objectManifest: BatchObjectManifestRow[]
  let projectionManifest: ProjectionManifestRow[]
  let projection: ProjectionManifestByType
  let counts: VerifiedProjectionCounts
  let sampledSessions: Array<{ id: string; title: string | null; turnCount: number }>
  try {
    await ctx.transaction(async (tx) => {
      batch = await requireBatchForVerification({
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

      objectManifest = await loadObjectManifest(tx, input.batchId, ctx.tenantId)
      projectionManifest = await loadProjectionManifest(tx, input.batchId, ctx.tenantId)
      projection = groupProjectionManifest(projectionManifest)

      assertDeclaredManifestMatches(input, objectManifest, projection)

      counts = await countProjectionRows({ rawExec: tx, tenantId: ctx.tenantId, projection })
      assertProjectionRowsExist(projection, counts)

      sampledSessions = await sampleSessions({ rawExec: tx, tenantId: ctx.tenantId, input, projection })
    })

    await verifyObjectManifest({
      rawExec: ctx.rawExec,
      objectStore: ctx.objectStore,
      tenantId: ctx.tenantId,
      objectManifest: objectManifest!,
    })

    return await ctx.transaction(async (tx) => {
      const receipt = buildPromotionReceipt({
        batchId: input.batchId,
        tenantId: ctx.tenantId,
        batch: batch!,
        objectManifest: objectManifest!,
        projectionManifest: projectionManifest!,
        projection: projection!,
        counts: counts!,
      })

      await savePromotionReceipt({
        rawExec: tx,
        tenantId: ctx.tenantId,
        batchId: input.batchId,
        batch: batch!,
        receipt,
      })

      return { receipt, sampledSessions: sampledSessions! }
    })
  } catch (error) {
    if (verificationStarted) {
      await markBatchFailed(ctx.rawExec, input.batchId, ctx.tenantId, error)
    }
    throw error
  }
}
