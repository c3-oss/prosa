// Lane 6 — `POST /v2/reads/search/query` handler.
//
// Postgres-FTS search across `search_doc`. The gate enforces that
// only docs whose `(tenant_id, store_id, receipt_id)` triple points
// to the tenant's *current* `remote_authority_v2` row are visible —
// docs from superseded receipts (or other tenants) never surface.
//
// The query is parameterized so the FTS string itself is bound, not
// concatenated. Snippets are produced via `ts_headline` and the
// cursor encodes the stable `(rank, doc_id)` tuple so paging stays
// reproducible even when the index grows during the iteration.
//
// Supported filters (all optional, all composable):
//
//   - `roles`              → `d.role = ANY(...)`
//   - `toolNames`          → `d.tool_name = ANY(...)`
//   - `canonicalToolTypes` → `d.canonical_tool_type = ANY(...)`
//   - `errorsOnly`         → `d.errors_only = TRUE`
//   - `sessionId`          → `d.session_id = $n`
//   - `entityTypes`        → `d.entity_type = ANY(...)`
//   - `since` / `until`    → `d.timestamp` bounds

import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import {
  type AuthoritySnapshot,
  InvalidCursorError,
  decodeRequiredCursor,
  encodeCursorSnapshot,
  encodeSignedCursor,
  parseCursorSnapshot,
  resolveAuthoritySnapshot,
  verifiedProjectionInSnapshotWhere,
} from '../shared/authority-snapshot.js'
import type { CursorSigner } from '../shared/cursor-signer.js'

export const searchQueryInput = z.object({
  q: z.string().min(1),
  roles: z.array(z.string().min(1)).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  canonicalToolTypes: z.array(z.string().min(1)).optional(),
  entityTypes: z.array(z.string().min(1)).optional(),
  errorsOnly: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  cursor: z.string().optional().nullable(),
  limit: z.number().int().min(1).max(200).default(50),
})

export type SearchQueryInput = z.infer<typeof searchQueryInput>

export type SearchHit = {
  docId: string
  entityType: string
  entityId: string
  sessionId: string | null
  projectId: string | null
  timestamp: string | null
  role: string | null
  toolName: string | null
  canonicalToolType: string | null
  fieldKind: string
  errorsOnly: boolean
  snippet: string
  rank: number
  storeId: string
  receiptId: string
}

export type SearchQueryResponse = {
  rows: SearchHit[]
  nextCursor: string | null
}

type DbRow = {
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string | null
  project_id: string | null
  timestamp: string | null
  role: string | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: string
  errors_only: boolean
  snippet: string
  rank: number
  store_id: string
  receipt_id: string
}

type StoredCursor = {
  rank: number
  id: string
  snapshot: Array<{ s: string; r: string }>
}

export type SearchDeps = {
  rawExec: RawExec
  cursorSigner: CursorSigner
}

function appendParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `$${params.length}`
}

export async function searchQuery(
  deps: SearchDeps,
  tenantId: string,
  input: SearchQueryInput,
): Promise<SearchQueryResponse> {
  // The FTS config — `english` is the canonical Postgres dictionary
  // available in every supported build. The lane doc mentions
  // `english_unaccent` for a deployment-time customization; falling
  // back to `english` keeps the gate-aware contract testable on
  // PGlite, which only ships the default dictionaries.
  const TS_CONFIG = "'english'"

  // CQ-142: pin the (store_id, receipt_id) snapshot at page 1 so
  // every page sees the same set of receipts. Subsequent pages
  // decode the snapshot from the cursor; tampered cursors throw
  // `InvalidCursorError` (HTTP 400 at the route layer).
  let snapshot: AuthoritySnapshot
  let cursorBound: { rank: number; id: string } | null = null
  const parsed = decodeRequiredCursor<StoredCursor>(deps.cursorSigner, input.cursor ?? undefined)
  if (parsed) {
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
      throw new InvalidCursorError('cursor.id missing')
    }
    if (typeof parsed.rank !== 'number' || !Number.isFinite(parsed.rank)) {
      throw new InvalidCursorError('cursor.rank must be a finite number')
    }
    snapshot = parseCursorSnapshot(parsed.snapshot)
    cursorBound = { rank: parsed.rank, id: parsed.id }
  } else {
    snapshot = await resolveAuthoritySnapshot(deps.rawExec, tenantId)
  }

  const params: unknown[] = [tenantId, input.q]
  const snapshotGate = verifiedProjectionInSnapshotWhere('d', '$1', snapshot, params)

  const filters: string[] = []
  if (input.roles && input.roles.length > 0) {
    const placeholders = input.roles.map((r) => appendParam(params, r)).join(', ')
    filters.push(`AND d.role IN (${placeholders})`)
  }
  if (input.toolNames && input.toolNames.length > 0) {
    const placeholders = input.toolNames.map((t) => appendParam(params, t)).join(', ')
    filters.push(`AND d.tool_name IN (${placeholders})`)
  }
  if (input.canonicalToolTypes && input.canonicalToolTypes.length > 0) {
    const placeholders = input.canonicalToolTypes.map((t) => appendParam(params, t)).join(', ')
    filters.push(`AND d.canonical_tool_type IN (${placeholders})`)
  }
  if (input.entityTypes && input.entityTypes.length > 0) {
    const placeholders = input.entityTypes.map((t) => appendParam(params, t)).join(', ')
    filters.push(`AND d.entity_type IN (${placeholders})`)
  }
  if (input.errorsOnly) {
    filters.push('AND d.errors_only = TRUE')
  }
  if (input.sessionId) {
    const p = appendParam(params, input.sessionId)
    filters.push(`AND d.session_id = ${p}`)
  }
  if (input.since) {
    const p = appendParam(params, input.since)
    filters.push(`AND d.timestamp >= ${p}::timestamptz`)
  }
  if (input.until) {
    const p = appendParam(params, input.until)
    filters.push(`AND d.timestamp < ${p}::timestamptz`)
  }

  let cursorClause = ''
  if (cursorBound) {
    const rankParam = appendParam(params, cursorBound.rank)
    const idParam = appendParam(params, cursorBound.id)
    // FTS rank is descending; `doc_id` ascending is the tiebreaker.
    cursorClause = ` AND (
      ts_rank_cd(d.text_tsv, websearch_to_tsquery(${TS_CONFIG}, $2)) < ${rankParam}
      OR (
        ts_rank_cd(d.text_tsv, websearch_to_tsquery(${TS_CONFIG}, $2)) = ${rankParam}
        AND d.doc_id > ${idParam}
      )
    )`
  }

  const fetchLimit = input.limit + 1
  const limitParam = appendParam(params, fetchLimit)

  const sql = `
    SELECT d.doc_id, d.entity_type, d.entity_id, d.session_id, d.project_id,
           to_char(d.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
           d.role, d.tool_name, d.canonical_tool_type, d.field_kind, d.errors_only,
           ts_headline(${TS_CONFIG}, d.text,
             websearch_to_tsquery(${TS_CONFIG}, $2),
             'MaxFragments=2,MinWords=8,MaxWords=24,ShortWord=3,HighlightAll=FALSE') AS snippet,
           ts_rank_cd(d.text_tsv, websearch_to_tsquery(${TS_CONFIG}, $2)) AS rank,
           d.store_id, d.receipt_id
      FROM search_doc d
     WHERE ${snapshotGate}
       AND d.text_tsv @@ websearch_to_tsquery(${TS_CONFIG}, $2)
       ${filters.join('\n       ')}
       ${cursorClause}
     ORDER BY rank DESC, d.doc_id ASC
     LIMIT ${limitParam}
  `

  const rows = await deps.rawExec<DbRow>(sql, params)
  const overflow = rows.length > input.limit
  const pageRows = overflow ? rows.slice(0, input.limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    overflow && last
      ? encodeSignedCursor(deps.cursorSigner, {
          rank: last.rank,
          id: last.doc_id,
          snapshot: encodeCursorSnapshot(snapshot),
        })
      : null

  return {
    rows: pageRows.map(mapHit),
    nextCursor,
  }
}

function mapHit(row: DbRow): SearchHit {
  return {
    docId: row.doc_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    timestamp: row.timestamp,
    role: row.role,
    toolName: row.tool_name,
    canonicalToolType: row.canonical_tool_type,
    fieldKind: row.field_kind,
    errorsOnly: row.errors_only,
    snippet: row.snippet,
    rank: row.rank,
    storeId: row.store_id,
    receiptId: row.receipt_id,
  }
}
