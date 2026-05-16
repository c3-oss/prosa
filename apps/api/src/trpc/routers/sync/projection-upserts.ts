import type {
  ProjectionPayload,
  ProjectionSessionRow,
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
    projection.searchDocs.length
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
      { kind: 'json', label: 'raw record payload', existing: row.payload, incoming: rawRecord.payload ?? null },
      { kind: 'nullable', label: 'raw record objectId', existing: row.object_id, incoming: rawRecord.objectId ?? null },
    ],
    insertSql: `INSERT INTO "raw_record"(tenant_id, id, source_file_id, sequence, payload, object_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    insertParams: [
      tenantId,
      rawRecord.id,
      rawRecord.sourceFileId,
      rawRecord.sequence,
      JSON.stringify(rawRecord.payload ?? null),
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
}
