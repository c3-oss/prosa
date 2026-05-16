import type {
  ProjectionArtifactRow,
  ProjectionContentBlockRow,
  ProjectionEventRow,
  ProjectionMessageRow,
  ProjectionPayload,
  ProjectionSessionRow,
  ProjectionToolCallRow,
  ProjectionToolResultRow,
  RawRecordRow,
  SearchDocRow,
  SourceFileRow,
} from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'
import { type ProjectionEntityType, stableJson } from './manifest.js'

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null
  return new Date(String(value)).toISOString()
}

type FieldCheck =
  | { kind: 'nullable'; label: string; existing: unknown; incoming: unknown }
  | { kind: 'json'; label: string; existing: unknown; incoming: unknown }
  | { kind: 'timestamp'; label: string; existing: unknown; incoming: unknown }

function assertSameField(check: FieldCheck): void {
  const match =
    check.kind === 'json'
      ? stableJson(check.existing ?? null) === stableJson(check.incoming ?? null)
      : check.kind === 'timestamp'
        ? normalizeTimestamp(check.existing) === normalizeTimestamp(check.incoming)
        : (check.existing ?? null) === (check.incoming ?? null)
  if (!match) {
    throw new TRPCError({ code: 'CONFLICT', message: `Conflicting ${check.label}` })
  }
}

function normalizeRawRecordPayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload ?? null
  }
  const { importBatchId: _importBatchId, ...stablePayload } = payload as Record<string, unknown>
  return stablePayload
}

/**
 * Idempotent upsert: if a row with the given primary key already exists, every
 * declared field must match (otherwise we throw CONFLICT). If no row exists,
 * the insert runs. Centralizing this lets each entity hand off its select
 * columns and equality predicates without re-implementing the dance.
 */
async function insertOrVerifyRow<TRow extends Record<string, unknown>>(opts: {
  rawExec: RawExec
  table: string
  selectColumns: string
  tenantId: string
  id: string
  buildChecks: (existing: TRow) => FieldCheck[]
  insertSql: string
  insertParams: unknown[]
}): Promise<void> {
  const existing = await opts.rawExec<TRow>(
    `SELECT ${opts.selectColumns} FROM "${opts.table}" WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [opts.tenantId, opts.id],
  )
  const row = existing[0]
  if (row) {
    for (const check of opts.buildChecks(row)) {
      assertSameField(check)
    }
    return
  }
  await opts.rawExec(opts.insertSql, opts.insertParams)
}

export function countProjectionRows(projection: ProjectionPayload): number {
  return (
    projection.sourceFiles.length +
    projection.rawRecords.length +
    projection.sessions.length +
    projection.searchDocs.length +
    projection.toolCalls.length +
    projection.toolResults.length +
    // Transcript-tier entities count toward the same per-batch row budget so
    // operators can keep a single mental model for `maxRowsPerCommit`.
    projection.messages.length +
    projection.contentBlocks.length +
    projection.events.length +
    projection.artifacts.length
  )
}

async function insertProjectionManifest(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  entityType: ProjectionEntityType
  entityId: string
}): Promise<void> {
  await opts.rawExec(
    `INSERT INTO "sync_batch_projection_manifest"(batch_id, tenant_id, entity_type, entity_id)
     VALUES ($1, $2, $3, $4)`,
    [opts.batchId, opts.tenantId, opts.entityType, opts.entityId],
  )
}

async function insertSessionRow(opts: {
  rawExec: RawExec
  tenantId: string
  session: ProjectionSessionRow
}): Promise<void> {
  const { rawExec, tenantId, session } = opts
  await insertOrVerifyRow<{
    source_kind: string
    project_id: string | null
    title: string | null
    started_at: unknown
    ended_at: unknown
    turn_count: number
    metadata: unknown
  }>({
    rawExec,
    table: 'projection_session',
    selectColumns: 'source_kind, project_id, title, started_at, ended_at, turn_count, metadata',
    tenantId,
    id: session.id,
    buildChecks: (row) => [
      { kind: 'nullable', label: 'session sourceKind', existing: row.source_kind, incoming: session.sourceKind },
      { kind: 'nullable', label: 'session projectId', existing: row.project_id, incoming: session.projectId ?? null },
      { kind: 'nullable', label: 'session title', existing: row.title, incoming: session.title ?? null },
      { kind: 'timestamp', label: 'session startedAt', existing: row.started_at, incoming: session.startedAt ?? null },
      { kind: 'timestamp', label: 'session endedAt', existing: row.ended_at, incoming: session.endedAt ?? null },
      { kind: 'nullable', label: 'session turnCount', existing: row.turn_count, incoming: session.turnCount },
      { kind: 'json', label: 'session metadata', existing: row.metadata, incoming: session.metadata ?? null },
    ],
    insertSql: `INSERT INTO "projection_session"(tenant_id, id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    insertParams: [
      tenantId,
      session.id,
      session.sourceKind,
      session.projectId ?? null,
      session.title ?? null,
      session.startedAt ?? null,
      session.endedAt ?? null,
      session.turnCount,
      session.metadata ? JSON.stringify(session.metadata) : null,
    ],
  })
}

async function insertSourceFileRow(opts: {
  rawExec: RawExec
  tenantId: string
  sourceFile: SourceFileRow
}): Promise<void> {
  const { rawExec, tenantId, sourceFile } = opts
  await insertOrVerifyRow<{
    source_kind: string
    path: string
    object_id: string | null
    metadata: unknown
  }>({
    rawExec,
    table: 'source_file',
    selectColumns: 'source_kind, path, object_id, metadata',
    tenantId,
    id: sourceFile.id,
    buildChecks: (row) => [
      { kind: 'nullable', label: 'source file sourceKind', existing: row.source_kind, incoming: sourceFile.sourceKind },
      { kind: 'nullable', label: 'source file path', existing: row.path, incoming: sourceFile.path },
      {
        kind: 'nullable',
        label: 'source file objectId',
        existing: row.object_id,
        incoming: sourceFile.objectId ?? null,
      },
      { kind: 'json', label: 'source file metadata', existing: row.metadata, incoming: sourceFile.metadata ?? null },
    ],
    insertSql: `INSERT INTO "source_file"(tenant_id, id, source_kind, path, object_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    insertParams: [
      tenantId,
      sourceFile.id,
      sourceFile.sourceKind,
      sourceFile.path,
      sourceFile.objectId ?? null,
      sourceFile.metadata ? JSON.stringify(sourceFile.metadata) : null,
    ],
  })
}

async function insertRawRecordRow(opts: {
  rawExec: RawExec
  tenantId: string
  rawRecord: RawRecordRow
}): Promise<void> {
  const { rawExec, tenantId, rawRecord } = opts
  const stablePayload = normalizeRawRecordPayload(rawRecord.payload ?? null)
  await insertOrVerifyRow<{
    source_file_id: string
    sequence: number
    payload: unknown
    object_id: string | null
  }>({
    rawExec,
    table: 'raw_record',
    selectColumns: 'source_file_id, sequence, payload, object_id',
    tenantId,
    id: rawRecord.id,
    buildChecks: (row) => [
      {
        kind: 'nullable',
        label: 'raw record sourceFileId',
        existing: row.source_file_id,
        incoming: rawRecord.sourceFileId,
      },
      { kind: 'nullable', label: 'raw record sequence', existing: row.sequence, incoming: rawRecord.sequence },
      {
        kind: 'json',
        label: 'raw record payload',
        existing: normalizeRawRecordPayload(row.payload),
        incoming: stablePayload,
      },
      { kind: 'nullable', label: 'raw record objectId', existing: row.object_id, incoming: rawRecord.objectId ?? null },
    ],
    insertSql: `INSERT INTO "raw_record"(tenant_id, id, source_file_id, sequence, payload, object_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    insertParams: [
      tenantId,
      rawRecord.id,
      rawRecord.sourceFileId,
      rawRecord.sequence,
      JSON.stringify(stablePayload),
      rawRecord.objectId ?? null,
    ],
  })
}

async function insertSearchDocRow(opts: {
  rawExec: RawExec
  tenantId: string
  searchDoc: SearchDocRow
}): Promise<void> {
  const { rawExec, tenantId, searchDoc } = opts
  await insertOrVerifyRow<{ session_id: string; kind: string; body: string }>({
    rawExec,
    table: 'search_doc',
    selectColumns: 'session_id, kind, body',
    tenantId,
    id: searchDoc.id,
    buildChecks: (row) => [
      { kind: 'nullable', label: 'search doc sessionId', existing: row.session_id, incoming: searchDoc.sessionId },
      { kind: 'nullable', label: 'search doc kind', existing: row.kind, incoming: searchDoc.kind },
      { kind: 'nullable', label: 'search doc body', existing: row.body, incoming: searchDoc.body },
    ],
    insertSql: `INSERT INTO "search_doc"(tenant_id, id, session_id, kind, body)
     VALUES ($1, $2, $3, $4, $5)`,
    insertParams: [tenantId, searchDoc.id, searchDoc.sessionId, searchDoc.kind, searchDoc.body],
  })
}

async function insertToolCallRow(opts: {
  rawExec: RawExec
  tenantId: string
  toolCall: ProjectionToolCallRow
}): Promise<void> {
  const { rawExec, tenantId, toolCall } = opts
  await insertOrVerifyRow<{
    session_id: string
    turn_id: string | null
    name: string
    status: string | null
    input_object_id: string | null
    created_at: unknown
  }>({
    rawExec,
    table: 'projection_tool_call',
    selectColumns: 'session_id, turn_id, name, status, input_object_id, created_at',
    tenantId,
    id: toolCall.id,
    buildChecks: (row) => [
      { kind: 'nullable', label: 'tool call sessionId', existing: row.session_id, incoming: toolCall.sessionId },
      { kind: 'nullable', label: 'tool call turnId', existing: row.turn_id, incoming: toolCall.turnId ?? null },
      { kind: 'nullable', label: 'tool call name', existing: row.name, incoming: toolCall.name },
      { kind: 'nullable', label: 'tool call status', existing: row.status, incoming: toolCall.status ?? null },
      {
        kind: 'nullable',
        label: 'tool call inputObjectId',
        existing: row.input_object_id,
        incoming: toolCall.inputObjectId ?? null,
      },
      {
        kind: 'timestamp',
        label: 'tool call createdAt',
        existing: row.created_at,
        incoming: toolCall.createdAt ?? null,
      },
    ],
    insertSql: `INSERT INTO "projection_tool_call"(tenant_id, id, session_id, turn_id, name, status, input_object_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    insertParams: [
      tenantId,
      toolCall.id,
      toolCall.sessionId,
      toolCall.turnId ?? null,
      toolCall.name,
      toolCall.status ?? null,
      toolCall.inputObjectId ?? null,
      toolCall.createdAt ?? null,
    ],
  })
}

async function insertToolResultRow(opts: {
  rawExec: RawExec
  tenantId: string
  toolResult: ProjectionToolResultRow
}): Promise<void> {
  const { rawExec, tenantId, toolResult } = opts
  await insertOrVerifyRow<{
    tool_call_id: string
    output_object_id: string | null
    status: string | null
    finished_at: unknown
  }>({
    rawExec,
    table: 'projection_tool_result',
    selectColumns: 'tool_call_id, output_object_id, status, finished_at',
    tenantId,
    id: toolResult.id,
    buildChecks: (row) => [
      {
        kind: 'nullable',
        label: 'tool result toolCallId',
        existing: row.tool_call_id,
        incoming: toolResult.toolCallId,
      },
      {
        kind: 'nullable',
        label: 'tool result outputObjectId',
        existing: row.output_object_id,
        incoming: toolResult.outputObjectId ?? null,
      },
      { kind: 'nullable', label: 'tool result status', existing: row.status, incoming: toolResult.status ?? null },
      {
        kind: 'timestamp',
        label: 'tool result finishedAt',
        existing: row.finished_at,
        incoming: toolResult.finishedAt ?? null,
      },
    ],
    insertSql: `INSERT INTO "projection_tool_result"(tenant_id, id, tool_call_id, output_object_id, status, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    insertParams: [
      tenantId,
      toolResult.id,
      toolResult.toolCallId,
      toolResult.outputObjectId ?? null,
      toolResult.status ?? null,
      toolResult.finishedAt ?? null,
    ],
  })
}

async function insertMessageRow(opts: {
  rawExec: RawExec
  tenantId: string
  message: ProjectionMessageRow
}): Promise<void> {
  const { rawExec, tenantId, message } = opts
  await insertOrVerifyRow<{
    session_id: string
    turn_id: string | null
    role: string
    model: string | null
    created_at: unknown
  }>({
    rawExec,
    table: 'projection_message',
    selectColumns: 'session_id, turn_id, role, model, created_at',
    tenantId,
    id: message.id,
    buildChecks: (row) => [
      { kind: 'nullable', label: 'message sessionId', existing: row.session_id, incoming: message.sessionId },
      { kind: 'nullable', label: 'message turnId', existing: row.turn_id, incoming: message.turnId ?? null },
      { kind: 'nullable', label: 'message role', existing: row.role, incoming: message.role },
      { kind: 'nullable', label: 'message model', existing: row.model, incoming: message.model ?? null },
      {
        kind: 'timestamp',
        label: 'message createdAt',
        existing: row.created_at,
        incoming: message.createdAt ?? null,
      },
    ],
    insertSql: `INSERT INTO "projection_message"(tenant_id, id, session_id, turn_id, role, model, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    insertParams: [
      tenantId,
      message.id,
      message.sessionId,
      message.turnId ?? null,
      message.role,
      message.model ?? null,
      message.createdAt ?? null,
    ],
  })
}

async function insertContentBlockRow(opts: {
  rawExec: RawExec
  tenantId: string
  contentBlock: ProjectionContentBlockRow
}): Promise<void> {
  const { rawExec, tenantId, contentBlock } = opts
  await insertOrVerifyRow<{
    message_id: string
    sequence: number
    kind: string
    text: string | null
    object_id: string | null
    metadata: unknown
  }>({
    rawExec,
    table: 'projection_content_block',
    selectColumns: 'message_id, sequence, kind, text, object_id, metadata',
    tenantId,
    id: contentBlock.id,
    buildChecks: (row) => [
      {
        kind: 'nullable',
        label: 'content block messageId',
        existing: row.message_id,
        incoming: contentBlock.messageId,
      },
      { kind: 'nullable', label: 'content block sequence', existing: row.sequence, incoming: contentBlock.sequence },
      { kind: 'nullable', label: 'content block kind', existing: row.kind, incoming: contentBlock.kind },
      { kind: 'nullable', label: 'content block text', existing: row.text, incoming: contentBlock.text ?? null },
      {
        kind: 'nullable',
        label: 'content block objectId',
        existing: row.object_id,
        incoming: contentBlock.objectId ?? null,
      },
      {
        kind: 'json',
        label: 'content block metadata',
        existing: row.metadata,
        incoming: contentBlock.metadata ?? null,
      },
    ],
    insertSql: `INSERT INTO "projection_content_block"(tenant_id, id, message_id, sequence, kind, text, object_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    insertParams: [
      tenantId,
      contentBlock.id,
      contentBlock.messageId,
      contentBlock.sequence,
      contentBlock.kind,
      contentBlock.text ?? null,
      contentBlock.objectId ?? null,
      contentBlock.metadata ? JSON.stringify(contentBlock.metadata) : null,
    ],
  })
}

async function insertEventRow(opts: {
  rawExec: RawExec
  tenantId: string
  event: ProjectionEventRow
}): Promise<void> {
  const { rawExec, tenantId, event } = opts
  await insertOrVerifyRow<{
    session_id: string
    turn_id: string | null
    sequence: number
    kind: string
    payload: unknown
    occurred_at: unknown
  }>({
    rawExec,
    table: 'projection_event',
    selectColumns: 'session_id, turn_id, sequence, kind, payload, occurred_at',
    tenantId,
    id: event.id,
    buildChecks: (row) => [
      { kind: 'nullable', label: 'event sessionId', existing: row.session_id, incoming: event.sessionId },
      { kind: 'nullable', label: 'event turnId', existing: row.turn_id, incoming: event.turnId ?? null },
      { kind: 'nullable', label: 'event sequence', existing: row.sequence, incoming: event.sequence },
      { kind: 'nullable', label: 'event kind', existing: row.kind, incoming: event.kind },
      { kind: 'json', label: 'event payload', existing: row.payload, incoming: event.payload ?? null },
      {
        kind: 'timestamp',
        label: 'event occurredAt',
        existing: row.occurred_at,
        incoming: event.occurredAt ?? null,
      },
    ],
    insertSql: `INSERT INTO "projection_event"(tenant_id, id, session_id, turn_id, sequence, kind, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    insertParams: [
      tenantId,
      event.id,
      event.sessionId,
      event.turnId ?? null,
      event.sequence,
      event.kind,
      event.payload != null ? JSON.stringify(event.payload) : null,
      event.occurredAt ?? null,
    ],
  })
}

async function insertArtifactRow(opts: {
  rawExec: RawExec
  tenantId: string
  artifact: ProjectionArtifactRow
}): Promise<void> {
  const { rawExec, tenantId, artifact } = opts
  await insertOrVerifyRow<{
    session_id: string | null
    kind: string
    object_id: string | null
    size_bytes: string | number | null
    metadata: unknown
  }>({
    rawExec,
    table: 'projection_artifact',
    selectColumns: 'session_id, kind, object_id, size_bytes, metadata',
    tenantId,
    id: artifact.id,
    buildChecks: (row) => [
      {
        kind: 'nullable',
        label: 'artifact sessionId',
        existing: row.session_id,
        incoming: artifact.sessionId ?? null,
      },
      { kind: 'nullable', label: 'artifact kind', existing: row.kind, incoming: artifact.kind },
      {
        kind: 'nullable',
        label: 'artifact objectId',
        existing: row.object_id,
        incoming: artifact.objectId ?? null,
      },
      {
        kind: 'nullable',
        label: 'artifact sizeBytes',
        // Postgres returns `bigint` as a string when going through `postgres-js`,
        // so coerce both sides to Number for the equality predicate.
        existing: row.size_bytes != null ? Number(row.size_bytes) : null,
        incoming: artifact.sizeBytes ?? null,
      },
      {
        kind: 'json',
        label: 'artifact metadata',
        existing: row.metadata,
        incoming: artifact.metadata ?? null,
      },
    ],
    insertSql: `INSERT INTO "projection_artifact"(tenant_id, id, session_id, kind, object_id, size_bytes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    insertParams: [
      tenantId,
      artifact.id,
      artifact.sessionId ?? null,
      artifact.kind,
      artifact.objectId ?? null,
      artifact.sizeBytes ?? null,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null,
    ],
  })
}

export async function insertProjectionRows(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  projection: ProjectionPayload
}): Promise<void> {
  const { rawExec, tenantId, batchId, projection } = opts
  for (const session of projection.sessions) {
    await insertProjectionManifest({ rawExec, tenantId, batchId, entityType: 'session', entityId: session.id })
    await insertSessionRow({ rawExec, tenantId, session })
  }
  for (const sourceFile of projection.sourceFiles) {
    await insertProjectionManifest({
      rawExec,
      tenantId,
      batchId,
      entityType: 'source_file',
      entityId: sourceFile.id,
    })
    await insertSourceFileRow({ rawExec, tenantId, sourceFile })
  }
  for (const rawRecord of projection.rawRecords) {
    await insertProjectionManifest({
      rawExec,
      tenantId,
      batchId,
      entityType: 'raw_record',
      entityId: rawRecord.id,
    })
    await insertRawRecordRow({ rawExec, tenantId, rawRecord })
  }
  for (const searchDoc of projection.searchDocs) {
    await insertProjectionManifest({
      rawExec,
      tenantId,
      batchId,
      entityType: 'search_doc',
      entityId: searchDoc.id,
    })
    await insertSearchDocRow({ rawExec, tenantId, searchDoc })
  }
  for (const toolCall of projection.toolCalls) {
    await insertProjectionManifest({
      rawExec,
      tenantId,
      batchId,
      entityType: 'tool_call',
      entityId: toolCall.id,
    })
    await insertToolCallRow({ rawExec, tenantId, toolCall })
  }
  for (const toolResult of projection.toolResults) {
    await insertProjectionManifest({
      rawExec,
      tenantId,
      batchId,
      entityType: 'tool_result',
      entityId: toolResult.id,
    })
    await insertToolResultRow({ rawExec, tenantId, toolResult })
  }
  // Insert messages BEFORE content_blocks so the (tenant_id, message_id) FK
  // resolves even with deferred constraints disabled (e.g. PGlite test paths).
  for (const message of projection.messages) {
    await insertProjectionManifest({ rawExec, tenantId, batchId, entityType: 'message', entityId: message.id })
    await insertMessageRow({ rawExec, tenantId, message })
  }
  for (const contentBlock of projection.contentBlocks) {
    await insertProjectionManifest({
      rawExec,
      tenantId,
      batchId,
      entityType: 'content_block',
      entityId: contentBlock.id,
    })
    await insertContentBlockRow({ rawExec, tenantId, contentBlock })
  }
  for (const event of projection.events) {
    await insertProjectionManifest({ rawExec, tenantId, batchId, entityType: 'event', entityId: event.id })
    await insertEventRow({ rawExec, tenantId, event })
  }
  for (const artifact of projection.artifacts) {
    await insertProjectionManifest({ rawExec, tenantId, batchId, entityType: 'artifact', entityId: artifact.id })
    await insertArtifactRow({ rawExec, tenantId, artifact })
  }
}
