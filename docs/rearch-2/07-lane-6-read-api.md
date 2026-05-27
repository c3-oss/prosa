# Lane 6 — Read API

## Goal

Ship the receipt-pinned remote read API: sessions list/count/detail/transcript, search (Postgres FTS), tool calls audit, artifacts.getText, analytics. All reads gated on a verified `remote_authority_v2` receipt for the tenant. After this lane, the web console and the CLI's `prosa read *` commands can answer queries against the server.

## Depends on

- Lane 5 (Sync protocol) complete — reads need `projection_*` and `search_doc` populated with sealed receipts.
- Lane 4 (Server) complete — Postgres FTS index, partitions in place.

## Deliverables

- Router `apps/api/src/v2/reads/` with five sub-routers:
  - `sessions` (list, count, detail, transcript)
  - `search` (query)
  - `tool-calls` (list)
  - `artifacts` (getText)
  - `analytics` (summary, report)
- Authority refresh endpoint `GET /v2/stores/:storeId/authority`.
- Query-time aggregation for cross-store tenant views (no materialized `tenant_session_current`).
- Receipt-pinned cursor encoding for all paginated reads.
- 30 s server-side cache for authority lookups (per-tenant, in-process LRU).

## Tasks

1. **Authority refresh endpoint.** `GET /v2/stores/:storeId/authority?knownReceiptId=`. Returns `{ status: 'unchanged' | 'updated' | 'gone_or_forbidden', receipt?, expiresAt, auditStatus, repair? }`. Cached per tenant/store for 30 s in-process LRU; full TTL refresh on miss.
2. **Sessions list.** `POST /v2/reads/sessions/list`. Receipt-pinned: reads `projection_session` filtered by `tenant_id` AND `receipt_id IN (current receipts for tenant)`. Cursor: `{ startedAt, id }` base64url-encoded JSON. Filter by source_tool, project_id, time bounds.
3. **Sessions count.** `POST /v2/reads/sessions/count`. Cheap COUNT(*) with the same filters.
4. **Session detail.** `POST /v2/reads/sessions/detail`. Returns session row + counts of related entities. Auxiliary rows (events, artifacts) not yet promoted to verified-manifest in v2.0 → return empty arrays with `auxiliaryRowsAvailable: false`. (This mirrors v1's CQ-004 caveat.)
5. **Session transcript.** `POST /v2/reads/sessions/transcript`. **Heavy read.** Strategy: pre-shaped `session_blob_pack` would be ideal, but in v2.0 the server doesn't have the local session blob; it reconstructs page-by-page from `projection_message` + `projection_content_block` + `projection_tool_call` + `projection_tool_result`. Same multi-pass shape as v1 but with hash-bucket partition pruning. Defer body bytes > 8 KiB to `artifacts.getText`.
6. **Search.** `POST /v2/reads/search/query`. Uses Postgres FTS: `WHERE tenant_id = $1 AND tsv @@ websearch_to_tsquery('english_unaccent', $2)`. Filter by role, tool_name, canonical_tool_type, errors_only (all first-class columns now). Cursor: `{ rank, id }`.
7. **Tool calls list.** `POST /v2/reads/tool-calls/list`. Reads `projection_tool_call` + LATERAL JOIN to `projection_tool_result` for inline result status.
8. **Artifacts getText.** `POST /v2/reads/artifacts/getText`. Verify projection + tenant + receipt grant on the underlying object. Fetch bytes from S3 (signed URL or proxied stream), decompress, return UTF-8 up to a configurable byte budget. Binary artifacts return placeholder.
9. **Analytics summary.** `GET /v2/reads/analytics/summary`. Lightweight counts (sessions, objects, search docs, sources).
10. **Analytics report.** `POST /v2/reads/analytics/report`. The five fixed reports (sessions, tools, errors, models, projects) executed against Postgres-equivalent SQL of the canonical view shapes from Lane 3.
11. **Query-time cross-store aggregation.** For "all sessions across all stores in this tenant", no `tenant_session_current` materialized view exists. Instead: `SELECT ... FROM projection_session WHERE tenant_id = $1 ORDER BY start_ts DESC LIMIT 50` against the hash-bucket partitions. Conflict resolution (cross-store same logical session) done via `DISTINCT ON (source_tool, source_session_id)` ordered by `end_ts DESC, receipt_id DESC`. 30 s cache on the conflict-resolved view.
12. **Verified-projection gate everywhere.** All projection reads JOIN against `remote_authority_v2.current_receipt_id` to ensure they only see rows from a verified receipt for the tenant's stores. Lint check + integration test enforces.

## Concrete types and schemas

### Authority refresh handler

```ts
// apps/api/src/v2/reads/authority.ts
const AUTHORITY_CACHE_TTL_MS = 30_000
const authorityCache = new LRUCache<string, CachedAuthority>({ max: 10_000 })

export async function getAuthority(
  ctx: V2RequestContext,
  storeId: string,
  knownReceiptId: string | null,
): Promise<AuthorityRefreshResponse> {
  const cacheKey = `${ctx.tenantId}:${storeId}`
  const cached = authorityCache.get(cacheKey)
  const now = Date.now()

  if (cached && cached.expiresAt > now) {
    if (knownReceiptId === cached.receiptId) {
      return { status: 'unchanged', receiptId: cached.receiptId, expiresAt: new Date(cached.expiresAt).toISOString(), auditStatus: cached.auditStatus }
    }
    return { status: 'updated', receipt: cached.receipt, expiresAt: new Date(cached.expiresAt).toISOString(), auditStatus: cached.auditStatus }
  }

  const row = await ctx.db.query<AuthorityRow>(
    `SELECT a.current_receipt_id, a.current_bundle_root, a.promoted_at, r.payload, r.signature
       FROM remote_authority_v2 a
       JOIN receipt r ON r.receipt_id = a.current_receipt_id
      WHERE a.tenant_id = $1 AND a.store_id = $2`,
    [ctx.tenantId, storeId],
  )

  if (row.rows.length === 0) {
    return { status: 'gone_or_forbidden' }
  }

  const receipt: PromotionReceiptV2 = { payload: row.rows[0].payload, signature: row.rows[0].signature }
  const auditStatus = await fetchAuditStatus(ctx.db, ctx.tenantId, receipt.payload.receiptId)
  const expiresAt = now + AUTHORITY_CACHE_TTL_MS
  authorityCache.set(cacheKey, { receiptId: receipt.payload.receiptId, receipt, expiresAt, auditStatus })

  if (knownReceiptId === receipt.payload.receiptId) {
    return { status: 'unchanged', receiptId: receipt.payload.receiptId, expiresAt: new Date(expiresAt).toISOString(), auditStatus }
  }
  return { status: 'updated', receipt, expiresAt: new Date(expiresAt).toISOString(), auditStatus }
}
```

### Verified-projection gate (helper)

```ts
// apps/api/src/v2/reads/shared/verified-projection.ts
export function verifiedProjectionWhereClause(alias: string, tenantParam = '$1'): string {
  return `${alias}.tenant_id = ${tenantParam}
    AND ${alias}.receipt_id IN (
      SELECT current_receipt_id FROM remote_authority_v2
       WHERE tenant_id = ${tenantParam}
    )`
}
```

Every projection read uses this clause. There is no separate manifest table (`sync_batch_projection_manifest` from v1) — the `receipt_id` column on every projection row plus the `remote_authority_v2` lookup IS the gate.

### Sessions list

```ts
// apps/api/src/v2/reads/sessions/list.ts
export async function listSessions(
  ctx: V2RequestContext,
  input: ListSessionsInput,
): Promise<ListSessionsResponse> {
  const cursor = decodeCursor<{ startedAt: string; id: string }>(input.cursor)
  const cursorClause = cursor
    ? `AND (s.start_ts, s.id) < ($2, $3)`
    : ''
  const params = cursor ? [ctx.tenantId, cursor.startedAt, cursor.id] : [ctx.tenantId]

  const limit = Math.min(input.limit ?? 50, 500)

  const rows = await ctx.db.query<SessionRow>(`
    SELECT DISTINCT ON (s.source_tool, s.source_session_id)
           s.id, s.source_tool, s.source_session_id, s.project_id, p.display_name AS project_name,
           s.title, s.start_ts, s.end_ts, s.model_first, s.model_last, s.timeline_confidence,
           s.store_id, s.receipt_id
      FROM projection_session s
      LEFT JOIN projects p ON p.tenant_id = s.tenant_id AND p.project_id = s.project_id
     WHERE ${verifiedProjectionWhereClause('s')}
       ${cursorClause}
       ${buildFiltersSql(input.filters, params)}
     ORDER BY s.source_tool, s.source_session_id, s.end_ts DESC, s.receipt_id DESC
            -- secondary ordering for pagination cursor
     LIMIT ${limit}
  `, params)

  // Re-sort by start_ts DESC, id for the page output (DISTINCT ON requires its own ORDER BY).
  rows.rows.sort((a, b) => /* ... */)

  const nextCursor = rows.rows.length === limit
    ? encodeCursor({ startedAt: rows.rows[limit - 1].start_ts, id: rows.rows[limit - 1].id })
    : null

  return { rows: rows.rows, nextCursor }
}
```

### Search query (Postgres FTS)

```ts
// apps/api/src/v2/reads/search/query.ts
export async function searchQuery(
  ctx: V2RequestContext,
  input: SearchQueryInput,
): Promise<SearchQueryResponse> {
  const cursor = decodeCursor<{ rank: number; id: string }>(input.cursor)
  const params: unknown[] = [ctx.tenantId, input.q]

  const filters: string[] = []
  if (input.roles?.length) {
    filters.push(`AND d.role = ANY($${params.length + 1}::text[])`)
    params.push(input.roles)
  }
  if (input.toolNames?.length) {
    filters.push(`AND d.tool_name = ANY($${params.length + 1}::text[])`)
    params.push(input.toolNames)
  }
  if (input.canonicalToolTypes?.length) {
    filters.push(`AND d.canonical_tool_type = ANY($${params.length + 1}::text[])`)
    params.push(input.canonicalToolTypes)
  }
  if (input.errorsOnly) {
    filters.push('AND d.errors_only = true')
  }
  // ... session_id, time bounds

  const result = await ctx.db.query<SearchHit>(`
    SELECT d.id, d.entity_type, d.entity_id, d.session_id, d.timestamp,
           d.role, d.tool_name, d.canonical_tool_type, d.field_kind,
           ts_headline('english_unaccent', d.text,
             websearch_to_tsquery('english_unaccent', $2),
             'MaxFragments=2, MinWords=8, MaxWords=24') AS snippet,
           ts_rank_cd(d.tsv, websearch_to_tsquery('english_unaccent', $2)) AS rank
      FROM search_doc d
     WHERE ${verifiedProjectionWhereClause('d')}
       AND d.tsv @@ websearch_to_tsquery('english_unaccent', $2)
       ${filters.join(' ')}
     ORDER BY rank DESC, d.id
     LIMIT ${input.limit ?? 50}
  `, params)

  return {
    rows: result.rows,
    nextCursor: result.rows.length === (input.limit ?? 50)
      ? encodeCursor({ rank: result.rows[result.rows.length - 1].rank, id: result.rows[result.rows.length - 1].id })
      : null,
  }
}
```

### Session transcript (multi-pass)

```ts
// apps/api/src/v2/reads/sessions/transcript.ts
const INLINE_TEXT_BUDGET_BYTES = 8 * 1024

export async function getTranscriptPage(
  ctx: V2RequestContext,
  input: TranscriptPageInput,
): Promise<TranscriptPageResponse | null> {
  // 1. Session header (single row).
  const session = await ctx.db.query<SessionRow>(`
    SELECT s.* FROM projection_session s
     WHERE ${verifiedProjectionWhereClause('s')} AND s.id = $2 LIMIT 1
  `, [ctx.tenantId, input.sessionId])
  if (session.rows.length === 0) return null

  // 2. Counts (in parallel with messages query).
  const counts = await Promise.all([
    ctx.db.query<{ count: number }>(`SELECT count(*) FROM projection_message m WHERE ${verifiedProjectionWhereClause('m')} AND m.session_id = $2`, [ctx.tenantId, input.sessionId]),
    // ... tool_call_count, error_count
  ])

  // 3. Page of messages with row-number-derived ordinal.
  const messageCursor = decodeCursor<{ ord: number; id: string }>(input.cursor)
  const cursorClause = messageCursor ? `AND (ranked.ord, ranked.id) > ($3, $4)` : ''
  const params = messageCursor ? [ctx.tenantId, input.sessionId, messageCursor.ord, messageCursor.id] : [ctx.tenantId, input.sessionId]

  const messages = await ctx.db.query<MessageRow>(`
    SELECT * FROM (
      SELECT m.id, m.turn_id, m.role, m.model, m.timestamp,
             row_number() OVER (ORDER BY COALESCE(m.timestamp, '1970-01-01'), m.id) AS ord
        FROM projection_message m
       WHERE ${verifiedProjectionWhereClause('m')} AND m.session_id = $2
    ) ranked
    WHERE 1=1 ${cursorClause}
    ORDER BY ord ASC, id ASC
    LIMIT ${input.limit ?? 128}
  `, params)

  // 4. Blocks for the page's messages.
  // 5. Tool calls attached to turns on this page.
  // 6. Tool results.

  // 7. Inline bodies ≤ 8 KiB; defer larger to artifacts.getText.

  return assembleTranscriptPage(session.rows[0], messages.rows, blocks, toolCalls, toolResults)
}
```

## Tests

| File | Asserts |
|---|---|
| `apps/api/test/v2/reads/authority-refresh.test.ts` | First call hits DB; subsequent within 30 s hits cache; `knownReceiptId` matching returns `unchanged`. |
| `apps/api/test/v2/reads/verified-projection-gate.test.ts` | Inserting a projection_session row without a corresponding `remote_authority_v2` entry → reads return empty. |
| `apps/api/test/v2/reads/sessions-list.test.ts` | Pagination cursor stable across multiple calls; `DISTINCT ON (source_tool, source_session_id)` resolves cross-store conflicts. |
| `apps/api/test/v2/reads/search-fts.test.ts` | Search with all filters (`role`, `tool_name`, `canonical_tool_type`, `errors_only`) returns expected hits against fixture. |
| `apps/api/test/v2/reads/transcript-pagination.test.ts` | 500-message session paginates correctly; bodies > 8 KiB return `objectId` not `textInline`. |
| `apps/api/test/v2/reads/artifacts-get-text.test.ts` | Verified projection + tenant_pack_grant required; missing grant → 403. |
| `apps/api/test/v2/reads/analytics-report.test.ts` | All 5 fixed reports return rows with the contract column names. |
| `apps/api/test/v2/reads/cross-store-distinct.test.ts` | Two stores promoting same logical session → list returns one row, conflict resolved per (end_ts DESC, receipt_id DESC). |
| `apps/api/test/v2/reads/lint-no-direct-authority-write.test.ts` | grep-based lint: only `seal-promotion.ts` writes to `remote_authority_v2`. |

## Gate

The lane is complete when:

1. All test files above pass.
2. p95 latency under fixture load:
   - `sessions/list` < 200 ms
   - `search/query` < 200 ms
   - `sessions/transcript` first page < 500 ms (typical session, < 200 messages)
   - `artifacts/getText` (1 MiB) < 1 s
3. Verified-projection gate enforced: a row with no `remote_authority_v2` entry is invisible. CI lint check passes.
4. Authority cache 30 s TTL verified by load test (one Postgres query per 30 s per (tenant, store)).
5. Cross-store conflict resolution returns one row per logical session.

## Risks

| Risk | Mitigation |
|---|---|
| Postgres FTS slower than Tantivy at scale | Bench: 10M docs / 100 tenants. If p95 > 500 ms, escalate to Lane 10 review (potential v2.x Tantivy fleet). |
| Transcript multi-pass blows latency on long sessions | Profile: 5000-message session first page should still be < 1 s. If not, pre-shape via `session_blob_pack` (currently local-only) and add server-side blob cache. |
| Authority cache stale across multi-worker fleet | 30 s TTL is the bound. Acceptable per design (eventual consistency on the listing view). |
| `DISTINCT ON` with hash-bucket partitions confused by planner | Test fixture covers; add `EXPLAIN ANALYZE` snapshot to CI. |

## Unblocks

Lane 7 (`08-lane-7-cli-and-mcp.md`) — CLI and MCP consume `/v2/reads/*` endpoints and the authority refresh.
