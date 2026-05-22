// G7 cutover — server-side projection materialization.
//
// During seal, fetch every projection_arrow NDJSON segment the CLI
// uploaded, parse it, and bulk-insert the rows into the
// `projection_<entity>` tables stamped with the receipt's
// (tenant_id, store_id, receipt_id). Without this step the
// `read --authority remote` endpoints serve no rows even though
// the receipt is sealed.
//
// Two-phase design:
//
// 1. `parseProjectionSegments` runs BEFORE the receipt is signed:
//    it fetches and parses every projection_arrow segment so the
//    payload's `materialization.rowCountsByEntity` reflects what
//    will actually land in Postgres. Sign-and-derive happens with
//    real counts, so the receipt id changes when the bundle's
//    row population does.
// 2. `insertParsedProjection` runs INSIDE the seal transaction
//    that flips `promotion_staging.status` to `sealed`. Inserts
//    use `ON CONFLICT … DO UPDATE` so re-syncs (a different
//    bundleRoot for the same logical session) converge to the
//    most recent receipt without raising duplicate-key errors.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import { CANONICAL_ENTITY_TYPES, type CanonicalEntityType, ENTITY_PRIMARY_KEY } from '@c3-oss/prosa-types-v2'
import type { RawTx } from '../../db.js'
import { stagingObjectKey } from './upload-segment.js'

/**
 * Per-entity row counts attached to the receipt payload's
 * `materialization.rowCountsByEntity`.
 */
export type MaterializedRowCounts = Partial<Record<CanonicalEntityType, number>>

export type ParseProjectionDeps = {
  objectStore: RemoteObjectStore
  tenantId: string
}

export type ParseProjectionInput = {
  promotionId: string
  /**
   * Bundle head's `segments` list. Phase 1 filters for
   * `projection_arrow` kinds and resolves each to its staging
   * object key via `stagingObjectKey(...)`.
   */
  segments: ReadonlyArray<{
    segmentId: string
    kind: string
    entityType?: CanonicalEntityType
  }>
}

/**
 * Per-entity parsed rows ready for INSERT. Held in memory between
 * phase 1 and phase 2; seal-promotion handles the lifetime.
 */
export type ParsedProjection = {
  rowsByEntity: Partial<Record<CanonicalEntityType, Array<Record<string, unknown>>>>
  counts: MaterializedRowCounts
}

/**
 * Phase 1 — fetch every projection_arrow segment listed in the
 * bundle head, parse its NDJSON rows, and return them grouped by
 * entity type plus per-entity counts. No database writes happen
 * here; the caller uses `counts` to build the signed receipt
 * payload before invoking phase 2.
 */
export async function parseProjectionSegments(
  deps: ParseProjectionDeps,
  input: ParseProjectionInput,
): Promise<ParsedProjection> {
  const rowsByEntity: ParsedProjection['rowsByEntity'] = {}
  const counts: MaterializedRowCounts = {}
  for (const segment of input.segments) {
    if (segment.kind !== 'projection_arrow') continue
    if (!segment.entityType) continue
    if (!ENTITY_HANDLERS[segment.entityType]) continue
    const storageKey = stagingObjectKey(deps.tenantId, input.promotionId, segment.segmentId)
    const head = await deps.objectStore.head(storageKey)
    if (!head) {
      throw new SealMaterializationMissingBytesError(segment.segmentId, storageKey)
    }
    const bytes = await readAllBytes(deps.objectStore, storageKey)
    const rows = parseProjectionNdjson(bytes, segment.entityType)
    if (rows.length === 0) continue
    const bucket = rowsByEntity[segment.entityType] ?? []
    for (const row of rows) bucket.push(row)
    rowsByEntity[segment.entityType] = bucket
    counts[segment.entityType] = (counts[segment.entityType] ?? 0) + rows.length
  }
  return { rowsByEntity, counts }
}

export type InsertProjectionInput = {
  tenantId: string
  storeId: string
  receiptId: string
  parsed: ParsedProjection
}

/**
 * Phase 2 — bulk-insert every parsed row stamped with the receipt's
 * `(tenant_id, store_id, receipt_id)` tuple. Runs inside the seal
 * transaction so the materialized rows commit atomically with the
 * authority swap.
 */
export async function insertParsedProjection(tx: RawTx, input: InsertProjectionInput): Promise<void> {
  for (const entity of Object.keys(input.parsed.rowsByEntity) as CanonicalEntityType[]) {
    const handler = ENTITY_HANDLERS[entity]
    if (!handler) continue
    const rows = input.parsed.rowsByEntity[entity] ?? []
    if (rows.length === 0) continue
    await handler.insert(tx, {
      tenantId: input.tenantId,
      storeId: input.storeId,
      receiptId: input.receiptId,
      rows,
    })
  }
}

export class SealMaterializationMissingBytesError extends Error {
  override name = 'SealMaterializationMissingBytesError'
  readonly code = 'PROJECTION_BYTES_MISSING' as const
  constructor(
    readonly segmentId: string,
    readonly storageKey: string,
  ) {
    super(`projection segment ${segmentId} has no bytes at ${storageKey}`)
  }
}

export class SealMaterializationBadHeaderError extends Error {
  override name = 'SealMaterializationBadHeaderError'
  readonly code = 'PROJECTION_HEADER_INVALID' as const
  constructor(
    readonly entityType: CanonicalEntityType,
    detail: string,
  ) {
    super(`projection segment for ${entityType} has a malformed header: ${detail}`)
  }
}

async function readAllBytes(store: RemoteObjectStore, key: string): Promise<Uint8Array> {
  const stream = await store.get(key)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function parseProjectionNdjson(bytes: Uint8Array, expectedEntity: CanonicalEntityType): Array<Record<string, unknown>> {
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes)
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0]!.length === 0) {
    throw new SealMaterializationBadHeaderError(expectedEntity, 'segment is empty')
  }
  let header: { entityType?: string; segmentKind?: string }
  try {
    header = JSON.parse(lines[0]!) as { entityType?: string; segmentKind?: string }
  } catch (err) {
    throw new SealMaterializationBadHeaderError(expectedEntity, (err as Error).message)
  }
  if (header.segmentKind !== 'projection_ndjson') {
    throw new SealMaterializationBadHeaderError(expectedEntity, `segmentKind=${header.segmentKind ?? '<missing>'}`)
  }
  if (header.entityType !== expectedEntity) {
    throw new SealMaterializationBadHeaderError(
      expectedEntity,
      `entityType=${header.entityType ?? '<missing>'} does not match the segment's declared entity`,
    )
  }
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.length === 0) continue
    const row = JSON.parse(line) as Record<string, unknown>
    rows.push(sanitizeNulBytes(row) as Record<string, unknown>)
  }
  return rows
}

// Postgres JSONB rejects the U+0000 code point ("unsupported Unicode
// escape sequence"; SQLSTATE 22P05). v1's commit path sanitizes the
// same code point in promoted text + payloads (covered by
// `apps/api/test/sync.test.ts > sanitizes NUL bytes in promoted
// projection text and JSON payloads`). Real-world bundles carry NULs
// in shell output captured into tool_result.stdout / artifact text;
// strip them at the materialization boundary so the JSONB insert
// succeeds. Keep the canonical row's other bytes verbatim — only the
// inline U+0000 is dropped.
const NUL_CHAR = String.fromCharCode(0)
const NUL_REGEX = new RegExp(NUL_CHAR, 'g')

function sanitizeNulBytes(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.indexOf(NUL_CHAR) === -1 ? value : value.replace(NUL_REGEX, '')
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeNulBytes)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeNulBytes(v)
    }
    return out
  }
  return value
}

type EntityInsertInput = {
  tenantId: string
  storeId: string
  receiptId: string
  rows: ReadonlyArray<Record<string, unknown>>
}

type EntityHandler = {
  insert: (tx: RawTx, input: EntityInsertInput) => Promise<void>
}

// Each handler emits the canonical INSERT into a `projection_<entity>`
// table. We project a small handful of denormalized columns from the
// row (the ones the v2 read endpoints filter / order by) and stash
// the full row JSON in `payload` so downstream consumers can read
// whatever else the canonical schema carried. `ON CONFLICT … DO
// UPDATE` keeps re-syncs idempotent: the latest receipt wins.
const ENTITY_HANDLERS: Partial<Record<CanonicalEntityType, EntityHandler>> = {
  session: {
    insert: async (tx, { tenantId, storeId, receiptId, rows }) => {
      await batchInsert(rows, ROWS_PER_BATCH, async (batch) => {
        const values: unknown[] = []
        const placeholders: string[] = []
        let i = 1
        for (const row of batch) {
          const pk = row[ENTITY_PRIMARY_KEY.session] as string | undefined
          if (!pk) continue
          placeholders.push(
            `($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10},$${i + 11},$${i + 12},$${i + 13},$${i + 14},$${i + 15},$${i + 16}::jsonb)`,
          )
          values.push(
            tenantId,
            pk,
            storeId,
            receiptId,
            stringOr(row.source_tool, 'unknown'),
            stringOr(row.source_session_id, pk),
            optString(row.project_id),
            optString(row.parent_session_id),
            stringOr(row.parent_resolution, 'unknown'),
            booleanOr(row.is_subagent, false),
            optString(row.title),
            optString(row.summary),
            optTimestamp(row.start_ts),
            optTimestamp(row.end_ts),
            optString(row.status),
            stringOr(row.timeline_confidence, 'medium'),
            JSON.stringify(row),
          )
          i += 17
        }
        if (placeholders.length === 0) return
        await tx(
          `INSERT INTO projection_session (
             tenant_id, session_id, store_id, receipt_id,
             source_tool, source_session_id, project_id, parent_session_id,
             parent_resolution, is_subagent, title, summary,
             start_ts, end_ts, status, timeline_confidence,
             payload
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (tenant_id, session_id) DO UPDATE SET
             store_id = EXCLUDED.store_id,
             receipt_id = EXCLUDED.receipt_id,
             source_tool = EXCLUDED.source_tool,
             source_session_id = EXCLUDED.source_session_id,
             project_id = EXCLUDED.project_id,
             parent_session_id = EXCLUDED.parent_session_id,
             parent_resolution = EXCLUDED.parent_resolution,
             is_subagent = EXCLUDED.is_subagent,
             title = EXCLUDED.title,
             summary = EXCLUDED.summary,
             start_ts = EXCLUDED.start_ts,
             end_ts = EXCLUDED.end_ts,
             status = EXCLUDED.status,
             timeline_confidence = EXCLUDED.timeline_confidence,
             payload = EXCLUDED.payload`,
          values,
        )
      })
    },
  },
  message: {
    insert: async (tx, { tenantId, storeId, receiptId, rows }) => {
      await batchInsert(rows, ROWS_PER_BATCH, async (batch) => {
        const values: unknown[] = []
        const placeholders: string[] = []
        let i = 1
        for (const row of batch) {
          const pk = row[ENTITY_PRIMARY_KEY.message] as string | undefined
          if (!pk) continue
          placeholders.push(
            `($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10},$${i + 11}::jsonb)`,
          )
          values.push(
            tenantId,
            pk,
            storeId,
            receiptId,
            stringOr(row.session_id, ''),
            optString(row.turn_id),
            stringOr(row.role, 'unknown'),
            optString(row.model),
            optTimestamp(row.timestamp),
            integerOr(row.ordinal, 0),
            optString(row.parent_message_id),
            JSON.stringify(row),
          )
          i += 12
        }
        if (placeholders.length === 0) return
        await tx(
          `INSERT INTO projection_message (
             tenant_id, message_id, store_id, receipt_id,
             session_id, turn_id, role, model, timestamp, ordinal,
             parent_message_id, payload
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (tenant_id, message_id) DO UPDATE SET
             store_id = EXCLUDED.store_id,
             receipt_id = EXCLUDED.receipt_id,
             session_id = EXCLUDED.session_id,
             turn_id = EXCLUDED.turn_id,
             role = EXCLUDED.role,
             model = EXCLUDED.model,
             timestamp = EXCLUDED.timestamp,
             ordinal = EXCLUDED.ordinal,
             parent_message_id = EXCLUDED.parent_message_id,
             payload = EXCLUDED.payload`,
          values,
        )
      })
    },
  },
  tool_call: {
    insert: async (tx, { tenantId, storeId, receiptId, rows }) => {
      await batchInsert(rows, ROWS_PER_BATCH, async (batch) => {
        const values: unknown[] = []
        const placeholders: string[] = []
        let i = 1
        for (const row of batch) {
          const pk = row[ENTITY_PRIMARY_KEY.tool_call] as string | undefined
          if (!pk) continue
          placeholders.push(
            `($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9}::jsonb)`,
          )
          values.push(
            tenantId,
            pk,
            storeId,
            receiptId,
            stringOr(row.session_id, ''),
            optString(row.turn_id),
            stringOr(row.tool_name, 'unknown'),
            optString(row.canonical_tool_type),
            optTimestamp(row.timestamp_start),
            JSON.stringify(row),
          )
          i += 10
        }
        if (placeholders.length === 0) return
        await tx(
          `INSERT INTO projection_tool_call (
             tenant_id, tool_call_id, store_id, receipt_id,
             session_id, turn_id, tool_name, canonical_tool_type,
             timestamp_start, payload
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (tenant_id, tool_call_id) DO UPDATE SET
             store_id = EXCLUDED.store_id,
             receipt_id = EXCLUDED.receipt_id,
             session_id = EXCLUDED.session_id,
             turn_id = EXCLUDED.turn_id,
             tool_name = EXCLUDED.tool_name,
             canonical_tool_type = EXCLUDED.canonical_tool_type,
             timestamp_start = EXCLUDED.timestamp_start,
             payload = EXCLUDED.payload`,
          values,
        )
      })
    },
  },
  tool_result: {
    insert: async (tx, { tenantId, storeId, receiptId, rows }) => {
      await batchInsert(rows, ROWS_PER_BATCH, async (batch) => {
        const values: unknown[] = []
        const placeholders: string[] = []
        let i = 1
        for (const row of batch) {
          const pk = row[ENTITY_PRIMARY_KEY.tool_result] as string | undefined
          if (!pk) continue
          placeholders.push(
            `($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9}::jsonb)`,
          )
          values.push(
            tenantId,
            pk,
            storeId,
            receiptId,
            optString(row.tool_call_id),
            stringOr(row.session_id, ''),
            optString(row.status),
            booleanOr(row.is_error, false),
            optInteger(row.exit_code),
            JSON.stringify(row),
          )
          i += 10
        }
        if (placeholders.length === 0) return
        await tx(
          `INSERT INTO projection_tool_result (
             tenant_id, tool_result_id, store_id, receipt_id,
             tool_call_id, session_id, status, is_error, exit_code, payload
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (tenant_id, tool_result_id) DO UPDATE SET
             store_id = EXCLUDED.store_id,
             receipt_id = EXCLUDED.receipt_id,
             tool_call_id = EXCLUDED.tool_call_id,
             session_id = EXCLUDED.session_id,
             status = EXCLUDED.status,
             is_error = EXCLUDED.is_error,
             exit_code = EXCLUDED.exit_code,
             payload = EXCLUDED.payload`,
          values,
        )
      })
    },
  },
  artifact: {
    insert: async (tx, { tenantId, storeId, receiptId, rows }) => {
      await batchInsert(rows, ROWS_PER_BATCH, async (batch) => {
        const values: unknown[] = []
        const placeholders: string[] = []
        let i = 1
        for (const row of batch) {
          const pk = row[ENTITY_PRIMARY_KEY.artifact] as string | undefined
          if (!pk) continue
          placeholders.push(
            `($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10},$${i + 11}::jsonb)`,
          )
          values.push(
            tenantId,
            pk,
            storeId,
            receiptId,
            optString(row.session_id),
            optString(row.project_id),
            stringOr(row.source_tool, 'unknown'),
            stringOr(row.kind, 'unknown'),
            optString(row.object_id),
            optInteger(row.byte_length),
            optString(row.content_type),
            JSON.stringify(row),
          )
          i += 12
        }
        if (placeholders.length === 0) return
        await tx(
          `INSERT INTO projection_artifact (
             tenant_id, artifact_id, store_id, receipt_id,
             session_id, project_id, source_tool, kind, object_id,
             byte_length, content_type, payload
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (tenant_id, artifact_id) DO UPDATE SET
             store_id = EXCLUDED.store_id,
             receipt_id = EXCLUDED.receipt_id,
             session_id = EXCLUDED.session_id,
             project_id = EXCLUDED.project_id,
             source_tool = EXCLUDED.source_tool,
             kind = EXCLUDED.kind,
             object_id = EXCLUDED.object_id,
             byte_length = EXCLUDED.byte_length,
             content_type = EXCLUDED.content_type,
             payload = EXCLUDED.payload`,
          values,
        )
      })
    },
  },
}

// Sanity: every entity we handle must appear in CANONICAL_ENTITY_TYPES.
// This isn't a runtime check (the values come from the same module),
// but the assertion below catches a hypothetical drift if a handler
// references an entity type that's been removed upstream.
for (const entity of Object.keys(ENTITY_HANDLERS) as CanonicalEntityType[]) {
  if (!CANONICAL_ENTITY_TYPES.includes(entity)) {
    throw new Error(`seal-materialize: unknown canonical entity ${entity}`)
  }
}

const ROWS_PER_BATCH = 500

async function batchInsert<T>(
  rows: ReadonlyArray<T>,
  batchSize: number,
  flush: (batch: ReadonlyArray<T>) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    await flush(batch)
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function optString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function integerOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return fallback
}

function optInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return null
}

function optTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}
