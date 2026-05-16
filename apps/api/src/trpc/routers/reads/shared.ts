import { z } from 'zod'

export type ProjectionEntityType = 'source_file' | 'raw_record' | 'session' | 'search_doc' | 'tool_call' | 'tool_result'

/**
 * Build a SQL fragment that asserts a projection row has a verified sync
 * batch manifest entry for the tenant. Reads must never expose unverified
 * promoted data; this fragment is the shared gate.
 */
export function verifiedProjectionExistsSql(alias: string, entityType: ProjectionEntityType): string {
  return `EXISTS (
    SELECT 1
      FROM "sync_batch_projection_manifest" m
      JOIN "sync_batch" b
        ON b.id = m.batch_id
       AND b.tenant_id = m.tenant_id
       AND b.status = 'verified'
     WHERE m.tenant_id = ${alias}.tenant_id
       AND m.entity_type = '${entityType}'
       AND m.entity_id = ${alias}.id
  )`
}

export function tenantVerifiedProjectionSql(
  alias: string,
  entityType: ProjectionEntityType,
  tenantParam = '$1',
): string {
  return `${alias}.tenant_id = ${tenantParam} AND ${verifiedProjectionExistsSql(alias, entityType)}`
}

export const cursorPageInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
})

export const eventCursorPageInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(250).default(100),
})

// Mirrors `SOURCE_TOOLS` in @c3-oss/prosa-core. Kept hand-rolled so the API
// build does not have to pull the importers' native dependencies just to
// type-check this enum. New entries must be added in both places.
export const sourceKindEnum = z.enum(['codex', 'claude', 'gemini', 'cursor', 'hermes'])

export const timeRangeFilter = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
})

export const sourceFilter = z.object({
  sourceKinds: z.array(sourceKindEnum).optional(),
})

export type CursorPayload = Record<string, string | number | null>

/**
 * Encode an opaque pagination cursor as base64url over a JSON tuple. Cursors
 * are stable across pages because they carry the full sort tuple, not an
 * offset.
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor<T extends CursorPayload = CursorPayload>(cursor: string | undefined): T | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export type CursorPage<T> = {
  rows: T[]
  nextCursor: string | null
}

export function appendParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `$${params.length}`
}
