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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET source_kind = EXCLUDED.source_kind,
           project_id  = EXCLUDED.project_id,
           title       = EXCLUDED.title,
           started_at  = EXCLUDED.started_at,
           ended_at    = EXCLUDED.ended_at,
           turn_count  = EXCLUDED.turn_count,
           metadata    = EXCLUDED.metadata`,
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET source_kind = EXCLUDED.source_kind,
           path        = EXCLUDED.path,
           object_id   = EXCLUDED.object_id,
           metadata    = EXCLUDED.metadata`,
    [
      opts.tenantId,
      opts.items.map((f) => f.id),
      opts.items.map((f) => f.sourceKind),
      opts.items.map((f) => f.path),
      opts.items.map((f) => f.objectId ?? null),
      opts.items.map((f) => (f.metadata != null ? JSON.stringify(f.metadata) : null)),
    ],
  )
}

/**
 * Raw records carry semantic conflict detection: if the same record id is
 * promoted a second time with a materially different payload (after stripping
 * the volatile `importBatchId` field), we surface a CONFLICT error so callers
 * know the local store has diverged from what is already committed remotely.
 *
 * Strategy: load all already-existing rows in one SELECT, verify their
 * normalized payloads against the incoming batch, then bulk-insert only the
 * genuinely new ones.
 */
async function bulkInsertRawRecordRows(opts: {
  rawExec: RawExec
  tenantId: string
  items: RawRecordRow[]
}): Promise<void> {
  if (opts.items.length === 0) return

  // Fetch any rows that already exist under these ids.
  const ids = opts.items.map((r) => r.id)
  const existing = await opts.rawExec<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM "raw_record" WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [opts.tenantId, ids],
  )
  const existingById = new Map(existing.map((row) => [row.id, row.payload]))

  // Verify existing rows and collect the ids that are new.
  const newItems: RawRecordRow[] = []
  for (const rawRecord of opts.items) {
    const storedPayload = existingById.get(rawRecord.id)
    if (storedPayload !== undefined) {
      // Row already exists — verify the normalized payload matches.
      const incomingStable = stableJson(normalizeRawRecordPayload(rawRecord.payload ?? null))
      const existingStable = stableJson(normalizeRawRecordPayload(storedPayload))
      if (incomingStable !== existingStable) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Conflicting raw record payload' })
      }
      // Payload matches — nothing to do for this row.
    } else {
      newItems.push(rawRecord)
    }
  }

  if (newItems.length === 0) return
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
      newItems.map((r) => r.id),
      newItems.map((r) => r.sourceFileId),
      newItems.map((r) => r.sequence),
      newItems.map((r) => JSON.stringify(normalizeRawRecordPayload(r.payload ?? null))),
      newItems.map((r) => r.objectId ?? null),
    ],
  )
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           kind       = EXCLUDED.kind,
           body       = EXCLUDED.body`,
    [
      opts.tenantId,
      opts.items.map((d) => d.id),
      opts.items.map((d) => d.sessionId),
      opts.items.map((d) => d.kind),
      opts.items.map((d) => d.body),
    ],
  )
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET session_id      = EXCLUDED.session_id,
           turn_id         = EXCLUDED.turn_id,
           name            = EXCLUDED.name,
           status          = EXCLUDED.status,
           input_object_id = EXCLUDED.input_object_id,
           created_at      = EXCLUDED.created_at`,
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET tool_call_id      = EXCLUDED.tool_call_id,
           output_object_id  = EXCLUDED.output_object_id,
           status            = EXCLUDED.status,
           finished_at       = EXCLUDED.finished_at`,
    [
      opts.tenantId,
      opts.items.map((tr) => tr.id),
      opts.items.map((tr) => tr.toolCallId),
      opts.items.map((tr) => tr.outputObjectId ?? null),
      opts.items.map((tr) => tr.status ?? null),
      opts.items.map((tr) => tr.finishedAt ?? null),
    ],
  )
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           turn_id    = EXCLUDED.turn_id,
           role       = EXCLUDED.role,
           model      = EXCLUDED.model,
           created_at = EXCLUDED.created_at`,
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET message_id = EXCLUDED.message_id,
           sequence   = EXCLUDED.sequence,
           kind       = EXCLUDED.kind,
           text       = EXCLUDED.text,
           object_id  = EXCLUDED.object_id,
           metadata   = EXCLUDED.metadata`,
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET session_id  = EXCLUDED.session_id,
           turn_id     = EXCLUDED.turn_id,
           sequence    = EXCLUDED.sequence,
           kind        = EXCLUDED.kind,
           payload     = EXCLUDED.payload,
           occurred_at = EXCLUDED.occurred_at`,
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
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           kind       = EXCLUDED.kind,
           object_id  = EXCLUDED.object_id,
           size_bytes = EXCLUDED.size_bytes,
           metadata   = EXCLUDED.metadata`,
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
