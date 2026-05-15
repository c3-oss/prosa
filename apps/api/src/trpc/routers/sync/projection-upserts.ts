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

function assertSameJson(label: string, existing: unknown, incoming: unknown): void {
  if (stableJson(existing ?? null) !== stableJson(incoming ?? null)) {
    throw new TRPCError({ code: 'CONFLICT', message: `Conflicting ${label}` })
  }
}

function assertSameNullable(label: string, existing: unknown, incoming: unknown): void {
  if ((existing ?? null) !== (incoming ?? null)) {
    throw new TRPCError({ code: 'CONFLICT', message: `Conflicting ${label}` })
  }
}

function assertSameTimestamp(label: string, existing: unknown, incoming: unknown): void {
  if (normalizeTimestamp(existing) !== normalizeTimestamp(incoming)) {
    throw new TRPCError({ code: 'CONFLICT', message: `Conflicting ${label}` })
  }
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
  const existing = await rawExec<{
    source_kind: string
    project_id: string | null
    title: string | null
    started_at: unknown
    ended_at: unknown
    turn_count: number
    metadata: unknown
  }>(
    'SELECT source_kind, project_id, title, started_at, ended_at, turn_count, metadata FROM "projection_session" WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, session.id],
  )
  const row = existing[0]
  if (row) {
    assertSameNullable('session sourceKind', row.source_kind, session.sourceKind)
    assertSameNullable('session projectId', row.project_id, session.projectId ?? null)
    assertSameNullable('session title', row.title, session.title ?? null)
    assertSameTimestamp('session startedAt', row.started_at, session.startedAt ?? null)
    assertSameTimestamp('session endedAt', row.ended_at, session.endedAt ?? null)
    assertSameNullable('session turnCount', row.turn_count, session.turnCount)
    assertSameJson('session metadata', row.metadata, session.metadata ?? null)
    return
  }
  await rawExec(
    `INSERT INTO "projection_session"(tenant_id, id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
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
  )
}

async function insertSourceFileRow(opts: {
  rawExec: RawExec
  tenantId: string
  sourceFile: SourceFileRow
}): Promise<void> {
  const { rawExec, tenantId, sourceFile } = opts
  const existing = await rawExec<{
    source_kind: string
    path: string
    object_id: string | null
    metadata: unknown
  }>('SELECT source_kind, path, object_id, metadata FROM "source_file" WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
    tenantId,
    sourceFile.id,
  ])
  const row = existing[0]
  if (row) {
    assertSameNullable('source file sourceKind', row.source_kind, sourceFile.sourceKind)
    assertSameNullable('source file path', row.path, sourceFile.path)
    assertSameNullable('source file objectId', row.object_id, sourceFile.objectId ?? null)
    assertSameJson('source file metadata', row.metadata, sourceFile.metadata ?? null)
    return
  }
  await rawExec(
    `INSERT INTO "source_file"(tenant_id, id, source_kind, path, object_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      tenantId,
      sourceFile.id,
      sourceFile.sourceKind,
      sourceFile.path,
      sourceFile.objectId ?? null,
      sourceFile.metadata ? JSON.stringify(sourceFile.metadata) : null,
    ],
  )
}

async function insertRawRecordRow(opts: {
  rawExec: RawExec
  tenantId: string
  rawRecord: RawRecordRow
}): Promise<void> {
  const { rawExec, tenantId, rawRecord } = opts
  const existing = await rawExec<{
    source_file_id: string
    sequence: number
    payload: unknown
    object_id: string | null
  }>('SELECT source_file_id, sequence, payload, object_id FROM "raw_record" WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
    tenantId,
    rawRecord.id,
  ])
  const row = existing[0]
  if (row) {
    assertSameNullable('raw record sourceFileId', row.source_file_id, rawRecord.sourceFileId)
    assertSameNullable('raw record sequence', row.sequence, rawRecord.sequence)
    assertSameJson('raw record payload', row.payload, rawRecord.payload ?? null)
    assertSameNullable('raw record objectId', row.object_id, rawRecord.objectId ?? null)
    return
  }
  await rawExec(
    `INSERT INTO "raw_record"(tenant_id, id, source_file_id, sequence, payload, object_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      tenantId,
      rawRecord.id,
      rawRecord.sourceFileId,
      rawRecord.sequence,
      JSON.stringify(rawRecord.payload ?? null),
      rawRecord.objectId ?? null,
    ],
  )
}

async function insertSearchDocRow(opts: {
  rawExec: RawExec
  tenantId: string
  searchDoc: SearchDocRow
}): Promise<void> {
  const { rawExec, tenantId, searchDoc } = opts
  const existing = await rawExec<{ session_id: string; kind: string; body: string }>(
    'SELECT session_id, kind, body FROM "search_doc" WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, searchDoc.id],
  )
  const row = existing[0]
  if (row) {
    assertSameNullable('search doc sessionId', row.session_id, searchDoc.sessionId)
    assertSameNullable('search doc kind', row.kind, searchDoc.kind)
    assertSameNullable('search doc body', row.body, searchDoc.body)
    return
  }
  await rawExec(
    `INSERT INTO "search_doc"(tenant_id, id, session_id, kind, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, searchDoc.id, searchDoc.sessionId, searchDoc.kind, searchDoc.body],
  )
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
