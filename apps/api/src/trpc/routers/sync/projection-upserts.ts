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

function normalizeRawRecordPayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload ?? null
  }
  const { importBatchId: _importBatchId, ...stablePayload } = payload as Record<string, unknown>
  return stablePayload
}

function normalizeNullable(value: unknown): string | null {
  return value == null ? null : String(value)
}

function normalizeInteger(value: unknown): number {
  return Number(value)
}

function normalizeBigIntString(value: unknown): string | null {
  if (value == null) return null
  return BigInt(value as string | number | bigint).toString()
}

function normalizeJson(value: unknown): string {
  if (value == null) return 'null'
  if (typeof value === 'string') {
    try {
      return stableJson(JSON.parse(value))
    } catch {
      return stableJson(value)
    }
  }
  return stableJson(value)
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return date.toISOString()
}

function assertProjectionRowsMatch({
  table,
  id,
  actual,
  expected,
}: {
  table: string
  id: string
  actual: Record<string, unknown> | undefined
  expected: Record<string, unknown>
}): void {
  if (!actual) {
    throw new TRPCError({ code: 'CONFLICT', message: `Projection row missing after insert: ${table}/${id}` })
  }
  if (stableJson(actual) !== stableJson(expected)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: table === 'raw_record' ? 'Conflicting raw record payload' : `Conflicting projection row: ${table}/${id}`,
    })
  }
}

async function verifyProjectionRows<Row, StoredRow extends { id: string }>(opts: {
  rawExec: RawExec
  tenantId: string
  table: string
  ids: string[]
  selectSql: string
  expected: (row: Row) => Record<string, unknown>
  actual: (row: StoredRow) => Record<string, unknown>
  items: Row[]
  itemId: (row: Row) => string
}): Promise<void> {
  const stored = await opts.rawExec<StoredRow>(opts.selectSql, [opts.tenantId, opts.ids])
  const storedById = new Map(stored.map((row) => [row.id, row]))
  for (const item of opts.items) {
    const id = opts.itemId(item)
    const storedRow = storedById.get(id)
    assertProjectionRowsMatch({
      table: opts.table,
      id,
      actual: storedRow ? opts.actual(storedRow) : undefined,
      expected: opts.expected(item),
    })
  }
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

// ---------------------------------------------------------------------------
// Bulk manifest insert
// ---------------------------------------------------------------------------

async function bulkInsertProjectionManifest(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  entityType: ProjectionEntityType
  entityIds: string[]
}): Promise<void> {
  if (opts.entityIds.length === 0) return
  await opts.rawExec(
    `INSERT INTO "sync_batch_projection_manifest"(batch_id, tenant_id, entity_type, entity_id)
     SELECT $1, $2, $3, t.entity_id
       FROM unnest($4::text[]) AS t(entity_id)
     ON CONFLICT (batch_id, tenant_id, entity_type, entity_id) DO NOTHING`,
    [opts.batchId, opts.tenantId, opts.entityType, opts.entityIds],
  )
}

// ---------------------------------------------------------------------------
// Bulk entity row upserts
// ---------------------------------------------------------------------------

async function bulkInsertSessionRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionSessionRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_session"(tenant_id, id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
     SELECT $1, t.id, t.source_kind, t.project_id, t.title,
            t.started_at::timestamptz, t.ended_at::timestamptz,
            t.turn_count::int, t.metadata::jsonb
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::text[],
         $8::int[],
         $9::text[]
       ) AS t(id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((s) => s.id),
      opts.items.map((s) => s.sourceKind),
      opts.items.map((s) => s.projectId ?? null),
      opts.items.map((s) => s.title ?? null),
      opts.items.map((s) => s.startedAt ?? null),
      opts.items.map((s) => s.endedAt ?? null),
      opts.items.map((s) => s.turnCount),
      opts.items.map((s) => (s.metadata != null ? JSON.stringify(s.metadata) : null)),
    ],
  )
  await verifyProjectionRows<
    ProjectionSessionRow,
    {
      id: string
      source_kind: string
      project_id: string | null
      title: string | null
      started_at: Date | string | null
      ended_at: Date | string | null
      turn_count: string | number
      metadata: unknown
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_session',
    ids: opts.items.map((s) => s.id),
    selectSql:
      'SELECT id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata FROM "projection_session" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (s) => s.id,
    expected: (s) => ({
      source_kind: s.sourceKind,
      project_id: normalizeNullable(s.projectId),
      title: normalizeNullable(s.title),
      started_at: normalizeTimestamp(s.startedAt),
      ended_at: normalizeTimestamp(s.endedAt),
      turn_count: s.turnCount,
      metadata: normalizeJson(s.metadata),
    }),
    actual: (row) => ({
      source_kind: row.source_kind,
      project_id: normalizeNullable(row.project_id),
      title: normalizeNullable(row.title),
      started_at: normalizeTimestamp(row.started_at),
      ended_at: normalizeTimestamp(row.ended_at),
      turn_count: normalizeInteger(row.turn_count),
      metadata: normalizeJson(row.metadata),
    }),
  })
}

async function bulkInsertSourceFileRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: SourceFileRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "source_file"(tenant_id, id, source_kind, path, object_id, metadata)
     SELECT $1, t.id, t.source_kind, t.path, t.object_id, t.metadata::jsonb
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[]
       ) AS t(id, source_kind, path, object_id, metadata)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((f) => f.id),
      opts.items.map((f) => f.sourceKind),
      opts.items.map((f) => f.path),
      opts.items.map((f) => f.objectId ?? null),
      opts.items.map((f) => (f.metadata != null ? JSON.stringify(f.metadata) : null)),
    ],
  )
  await verifyProjectionRows<
    SourceFileRow,
    {
      id: string
      source_kind: string
      path: string
      object_id: string | null
      metadata: unknown
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'source_file',
    ids: opts.items.map((f) => f.id),
    selectSql:
      'SELECT id, source_kind, path, object_id, metadata FROM "source_file" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (f) => f.id,
    expected: (f) => ({
      source_kind: f.sourceKind,
      path: f.path,
      object_id: normalizeNullable(f.objectId),
      metadata: normalizeJson(f.metadata),
    }),
    actual: (row) => ({
      source_kind: row.source_kind,
      path: row.path,
      object_id: normalizeNullable(row.object_id),
      metadata: normalizeJson(row.metadata),
    }),
  })
}

async function bulkInsertRawRecordRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: RawRecordRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "raw_record"(tenant_id, id, source_file_id, sequence, payload, object_id)
     SELECT $1, t.id, t.source_file_id, t.sequence::int, t.payload::jsonb, t.object_id
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::int[],
         $5::text[],
         $6::text[]
       ) AS t(id, source_file_id, sequence, payload, object_id)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((r) => r.id),
      opts.items.map((r) => r.sourceFileId),
      opts.items.map((r) => r.sequence),
      opts.items.map((r) => JSON.stringify(normalizeRawRecordPayload(r.payload ?? null))),
      opts.items.map((r) => r.objectId ?? null),
    ],
  )
  await verifyProjectionRows<
    RawRecordRow,
    {
      id: string
      source_file_id: string
      sequence: string | number
      payload: unknown
      object_id: string | null
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'raw_record',
    ids: opts.items.map((r) => r.id),
    selectSql:
      'SELECT id, source_file_id, sequence, payload, object_id FROM "raw_record" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (r) => r.id,
    expected: (r) => ({
      source_file_id: r.sourceFileId,
      sequence: r.sequence,
      payload: normalizeJson(normalizeRawRecordPayload(r.payload ?? null)),
      object_id: normalizeNullable(r.objectId),
    }),
    actual: (row) => ({
      source_file_id: row.source_file_id,
      sequence: normalizeInteger(row.sequence),
      payload: normalizeJson(normalizeRawRecordPayload(row.payload)),
      object_id: normalizeNullable(row.object_id),
    }),
  })
}

async function bulkInsertSearchDocRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: SearchDocRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "search_doc"(tenant_id, id, session_id, kind, body)
     SELECT $1, t.id, t.session_id, t.kind, t.body
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[]
       ) AS t(id, session_id, kind, body)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((d) => d.id),
      opts.items.map((d) => d.sessionId),
      opts.items.map((d) => d.kind),
      opts.items.map((d) => d.body),
    ],
  )
  await verifyProjectionRows<
    SearchDocRow,
    {
      id: string
      session_id: string
      kind: string
      body: string
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'search_doc',
    ids: opts.items.map((d) => d.id),
    selectSql: 'SELECT id, session_id, kind, body FROM "search_doc" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (d) => d.id,
    expected: (d) => ({
      session_id: d.sessionId,
      kind: d.kind,
      body: d.body,
    }),
    actual: (row) => ({
      session_id: row.session_id,
      kind: row.kind,
      body: row.body,
    }),
  })
}

async function bulkInsertToolCallRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionToolCallRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_tool_call"(tenant_id, id, session_id, turn_id, name, status, input_object_id, created_at)
     SELECT $1, t.id, t.session_id, t.turn_id, t.name, t.status, t.input_object_id, t.created_at::timestamptz
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::text[],
         $8::text[]
       ) AS t(id, session_id, turn_id, name, status, input_object_id, created_at)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((tc) => tc.id),
      opts.items.map((tc) => tc.sessionId),
      opts.items.map((tc) => tc.turnId ?? null),
      opts.items.map((tc) => tc.name),
      opts.items.map((tc) => tc.status ?? null),
      opts.items.map((tc) => tc.inputObjectId ?? null),
      opts.items.map((tc) => tc.createdAt ?? null),
    ],
  )
  await verifyProjectionRows<
    ProjectionToolCallRow,
    {
      id: string
      session_id: string
      turn_id: string | null
      name: string
      status: string | null
      input_object_id: string | null
      created_at: Date | string | null
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_tool_call',
    ids: opts.items.map((tc) => tc.id),
    selectSql:
      'SELECT id, session_id, turn_id, name, status, input_object_id, created_at FROM "projection_tool_call" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (tc) => tc.id,
    expected: (tc) => ({
      session_id: tc.sessionId,
      turn_id: normalizeNullable(tc.turnId),
      name: tc.name,
      status: normalizeNullable(tc.status),
      input_object_id: normalizeNullable(tc.inputObjectId),
      created_at: normalizeTimestamp(tc.createdAt),
    }),
    actual: (row) => ({
      session_id: row.session_id,
      turn_id: normalizeNullable(row.turn_id),
      name: row.name,
      status: normalizeNullable(row.status),
      input_object_id: normalizeNullable(row.input_object_id),
      created_at: normalizeTimestamp(row.created_at),
    }),
  })
}

async function bulkInsertToolResultRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionToolResultRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_tool_result"(tenant_id, id, tool_call_id, output_object_id, status, finished_at)
     SELECT $1, t.id, t.tool_call_id, t.output_object_id, t.status, t.finished_at::timestamptz
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[]
       ) AS t(id, tool_call_id, output_object_id, status, finished_at)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((tr) => tr.id),
      opts.items.map((tr) => tr.toolCallId),
      opts.items.map((tr) => tr.outputObjectId ?? null),
      opts.items.map((tr) => tr.status ?? null),
      opts.items.map((tr) => tr.finishedAt ?? null),
    ],
  )
  await verifyProjectionRows<
    ProjectionToolResultRow,
    {
      id: string
      tool_call_id: string
      output_object_id: string | null
      status: string | null
      finished_at: Date | string | null
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_tool_result',
    ids: opts.items.map((tr) => tr.id),
    selectSql:
      'SELECT id, tool_call_id, output_object_id, status, finished_at FROM "projection_tool_result" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (tr) => tr.id,
    expected: (tr) => ({
      tool_call_id: tr.toolCallId,
      output_object_id: normalizeNullable(tr.outputObjectId),
      status: normalizeNullable(tr.status),
      finished_at: normalizeTimestamp(tr.finishedAt),
    }),
    actual: (row) => ({
      tool_call_id: row.tool_call_id,
      output_object_id: normalizeNullable(row.output_object_id),
      status: normalizeNullable(row.status),
      finished_at: normalizeTimestamp(row.finished_at),
    }),
  })
}

async function bulkInsertMessageRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionMessageRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_message"(tenant_id, id, session_id, turn_id, role, model, created_at)
     SELECT $1, t.id, t.session_id, t.turn_id, t.role, t.model, t.created_at::timestamptz
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::text[]
       ) AS t(id, session_id, turn_id, role, model, created_at)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((m) => m.id),
      opts.items.map((m) => m.sessionId),
      opts.items.map((m) => m.turnId ?? null),
      opts.items.map((m) => m.role),
      opts.items.map((m) => m.model ?? null),
      opts.items.map((m) => m.createdAt ?? null),
    ],
  )
  await verifyProjectionRows<
    ProjectionMessageRow,
    {
      id: string
      session_id: string
      turn_id: string | null
      role: string
      model: string | null
      created_at: Date | string | null
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_message',
    ids: opts.items.map((m) => m.id),
    selectSql:
      'SELECT id, session_id, turn_id, role, model, created_at FROM "projection_message" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (m) => m.id,
    expected: (m) => ({
      session_id: m.sessionId,
      turn_id: normalizeNullable(m.turnId),
      role: m.role,
      model: normalizeNullable(m.model),
      created_at: normalizeTimestamp(m.createdAt),
    }),
    actual: (row) => ({
      session_id: row.session_id,
      turn_id: normalizeNullable(row.turn_id),
      role: row.role,
      model: normalizeNullable(row.model),
      created_at: normalizeTimestamp(row.created_at),
    }),
  })
}

async function bulkInsertContentBlockRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionContentBlockRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_content_block"(tenant_id, id, message_id, sequence, kind, text, object_id, metadata)
     SELECT $1, t.id, t.message_id, t.sequence::int, t.kind, t.text, t.object_id, t.metadata::jsonb
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::int[],
         $5::text[],
         $6::text[],
         $7::text[],
         $8::text[]
       ) AS t(id, message_id, sequence, kind, text, object_id, metadata)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((cb) => cb.id),
      opts.items.map((cb) => cb.messageId),
      opts.items.map((cb) => cb.sequence),
      opts.items.map((cb) => cb.kind),
      opts.items.map((cb) => cb.text ?? null),
      opts.items.map((cb) => cb.objectId ?? null),
      opts.items.map((cb) => (cb.metadata != null ? JSON.stringify(cb.metadata) : null)),
    ],
  )
  await verifyProjectionRows<
    ProjectionContentBlockRow,
    {
      id: string
      message_id: string
      sequence: string | number
      kind: string
      text: string | null
      object_id: string | null
      metadata: unknown
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_content_block',
    ids: opts.items.map((cb) => cb.id),
    selectSql:
      'SELECT id, message_id, sequence, kind, text, object_id, metadata FROM "projection_content_block" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (cb) => cb.id,
    expected: (cb) => ({
      message_id: cb.messageId,
      sequence: cb.sequence,
      kind: cb.kind,
      text: normalizeNullable(cb.text),
      object_id: normalizeNullable(cb.objectId),
      metadata: normalizeJson(cb.metadata),
    }),
    actual: (row) => ({
      message_id: row.message_id,
      sequence: normalizeInteger(row.sequence),
      kind: row.kind,
      text: normalizeNullable(row.text),
      object_id: normalizeNullable(row.object_id),
      metadata: normalizeJson(row.metadata),
    }),
  })
}

async function bulkInsertEventRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionEventRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_event"(tenant_id, id, session_id, turn_id, sequence, kind, payload, occurred_at)
     SELECT $1, t.id, t.session_id, t.turn_id, t.sequence::int, t.kind, t.payload::jsonb, t.occurred_at::timestamptz
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::int[],
         $6::text[],
         $7::text[],
         $8::text[]
       ) AS t(id, session_id, turn_id, sequence, kind, payload, occurred_at)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((e) => e.id),
      opts.items.map((e) => e.sessionId),
      opts.items.map((e) => e.turnId ?? null),
      opts.items.map((e) => e.sequence),
      opts.items.map((e) => e.kind),
      opts.items.map((e) => (e.payload != null ? JSON.stringify(e.payload) : null)),
      opts.items.map((e) => e.occurredAt ?? null),
    ],
  )
  await verifyProjectionRows<
    ProjectionEventRow,
    {
      id: string
      session_id: string
      turn_id: string | null
      sequence: string | number
      kind: string
      payload: unknown
      occurred_at: Date | string | null
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_event',
    ids: opts.items.map((e) => e.id),
    selectSql:
      'SELECT id, session_id, turn_id, sequence, kind, payload, occurred_at FROM "projection_event" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (e) => e.id,
    expected: (e) => ({
      session_id: e.sessionId,
      turn_id: normalizeNullable(e.turnId),
      sequence: e.sequence,
      kind: e.kind,
      payload: normalizeJson(e.payload),
      occurred_at: normalizeTimestamp(e.occurredAt),
    }),
    actual: (row) => ({
      session_id: row.session_id,
      turn_id: normalizeNullable(row.turn_id),
      sequence: normalizeInteger(row.sequence),
      kind: row.kind,
      payload: normalizeJson(row.payload),
      occurred_at: normalizeTimestamp(row.occurred_at),
    }),
  })
}

async function bulkInsertArtifactRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: ProjectionArtifactRow[]
}): Promise<void> {
  if (opts.items.length === 0) return
  await opts.rawExec(
    `INSERT INTO "projection_artifact"(tenant_id, id, session_id, kind, object_id, size_bytes, metadata)
     SELECT $1, t.id, t.session_id, t.kind, t.object_id, t.size_bytes::bigint, t.metadata::jsonb
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::bigint[],
         $7::text[]
       ) AS t(id, session_id, kind, object_id, size_bytes, metadata)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      opts.tenantId,
      opts.items.map((a) => a.id),
      opts.items.map((a) => a.sessionId ?? null),
      opts.items.map((a) => a.kind),
      opts.items.map((a) => a.objectId ?? null),
      opts.items.map((a) => a.sizeBytes ?? null),
      opts.items.map((a) => (a.metadata != null ? JSON.stringify(a.metadata) : null)),
    ],
  )
  await verifyProjectionRows<
    ProjectionArtifactRow,
    {
      id: string
      session_id: string | null
      kind: string
      object_id: string | null
      size_bytes: string | number | bigint | null
      metadata: unknown
    }
  >({
    rawExec: opts.rawExec,
    tenantId: opts.tenantId,
    table: 'projection_artifact',
    ids: opts.items.map((a) => a.id),
    selectSql:
      'SELECT id, session_id, kind, object_id, size_bytes, metadata FROM "projection_artifact" WHERE tenant_id = $1 AND id = ANY($2::text[])',
    items: opts.items,
    itemId: (a) => a.id,
    expected: (a) => ({
      session_id: normalizeNullable(a.sessionId),
      kind: a.kind,
      object_id: normalizeNullable(a.objectId),
      size_bytes: normalizeBigIntString(a.sizeBytes),
      metadata: normalizeJson(a.metadata),
    }),
    actual: (row) => ({
      session_id: normalizeNullable(row.session_id),
      kind: row.kind,
      object_id: normalizeNullable(row.object_id),
      size_bytes: normalizeBigIntString(row.size_bytes),
      metadata: normalizeJson(row.metadata),
    }),
  })
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function insertProjectionRows(opts: {
  rawExec: RawExec
  tenantId: string
  batchId: string
  projection: ProjectionPayload
}): Promise<void> {
  const { rawExec, tenantId, batchId, projection } = opts

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'session',
    entityIds: projection.sessions.map((s) => s.id),
  })
  await bulkInsertSessionRows({ rawExec, tenantId, items: projection.sessions })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'source_file',
    entityIds: projection.sourceFiles.map((f) => f.id),
  })
  await bulkInsertSourceFileRows({ rawExec, tenantId, items: projection.sourceFiles })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'raw_record',
    entityIds: projection.rawRecords.map((r) => r.id),
  })
  await bulkInsertRawRecordRows({ rawExec, tenantId, items: projection.rawRecords })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'search_doc',
    entityIds: projection.searchDocs.map((d) => d.id),
  })
  await bulkInsertSearchDocRows({ rawExec, tenantId, items: projection.searchDocs })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'tool_call',
    entityIds: projection.toolCalls.map((tc) => tc.id),
  })
  await bulkInsertToolCallRows({ rawExec, tenantId, items: projection.toolCalls })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'tool_result',
    entityIds: projection.toolResults.map((tr) => tr.id),
  })
  await bulkInsertToolResultRows({ rawExec, tenantId, items: projection.toolResults })

  // Insert messages BEFORE content_blocks so the (tenant_id, message_id) FK
  // resolves even with deferred constraints disabled (e.g. PGlite test paths).
  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'message',
    entityIds: projection.messages.map((m) => m.id),
  })
  await bulkInsertMessageRows({ rawExec, tenantId, items: projection.messages })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'content_block',
    entityIds: projection.contentBlocks.map((cb) => cb.id),
  })
  await bulkInsertContentBlockRows({ rawExec, tenantId, items: projection.contentBlocks })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'event',
    entityIds: projection.events.map((e) => e.id),
  })
  await bulkInsertEventRows({ rawExec, tenantId, items: projection.events })

  await bulkInsertProjectionManifest({
    rawExec,
    tenantId,
    batchId,
    entityType: 'artifact',
    entityIds: projection.artifacts.map((a) => a.id),
  })
  await bulkInsertArtifactRows({ rawExec, tenantId, items: projection.artifacts })
}
