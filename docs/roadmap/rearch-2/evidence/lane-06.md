# Lane 6 Evidence - Read API

Status: in progress; Lane 5 accepted by Codex/governor on 2026-05-20.

## Slice 1 — Foundation (2026-05-20)

Landed:

- v2 projection schema now carries `(store_id, receipt_id)` on every
  projection table plus `search_doc`. The columns are populated by the
  Lane 10 materialization path; Lane 6 reads use them today to compose
  the verified-projection gate, and tests seed rows directly.
- `apps/api/src/v2/reads/shared/verified-projection.ts` —
  `verifiedProjectionWhere(alias, tenantParam)` is the single SQL gate
  fragment every projection / search read must compose. The lint test
  in `apps/api/test/v2/reads/lint-no-direct-projection-read.test.ts`
  fails when a new handler under `src/v2/reads/` mentions a
  `VERIFIED_PROJECTION_TABLES` entry without referencing the helper.
- `apps/api/src/v2/reads/authority-cache.ts` — in-process TTL cache
  keyed on `(tenant_id, store_id)` (default 30 s). Tests inject a
  smaller TTL + custom `now` for determinism.
- `apps/api/src/v2/reads/authority.ts` — `getAuthority` handler.
  Single Postgres round-trip joins `remote_authority_v2` to the signed
  `receipt` row and to the worst-status `pack_audit_state` so the
  response carries an `auditStatus` hint without a second query.
  Cache hit returns `unchanged | updated` from the cached value; miss
  fetches, validates, caches.
- `GET /v2/stores/:storeId/authority?knownReceiptId=...` route wired
  through `registerV2ReadRoutes` in `apps/api/src/v2/reads/index.ts`
  and registered by `registerV2Routes`. The route reuses
  `resolveV2AuthContext` so the same Better Auth session covers reads
  and writes; tenant scoping is enforced by the gate (a peer tenant's
  authority returns `gone_or_forbidden`).
- Lane 6 tests under `apps/api/test/v2/reads/`:
  - `authority-refresh.test.ts` (8 tests) — HTTP gate ladder + cache
    TTL semantics + per-(tenant, store) cache key isolation +
    `pack_audit_state` mapping.
  - `verified-projection-gate.test.ts` (5 tests) — SQL gate proves
    current/superseded/cross-tenant/cross-store visibility on a
    fresh v2-only PGlite.
  - `lint-no-direct-projection-read.test.ts` (1 test) — repo-walk
    catches any new read path that bypasses the gate.

Slice 1 gate evidence on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/
  → Test Files  3 passed (3)
  → Tests       14 passed (14)
pnpm --filter @c3-oss/prosa-db-v2 test
  → Test Files  1 passed (1)
  → Tests       6 passed (6)
pnpm typecheck
  → EXIT=0
pnpm lint
  → EXIT=0
```

`pnpm --filter @c3-oss/prosa-api test` (full suite) is the next-slice
gate; slice 1 ran the focused Lane 6 routes plus typecheck/lint clean.

## Slice 2 — Sessions list / count / detail (2026-05-20)

Landed:

- `apps/api/src/v2/reads/sessions/filters.ts` — `sessionListFilters`
  Zod schema and `buildSessionWhere(tenantId, filters)`. The helper
  builds the WHERE fragment + positional parameter array threading
  the verified-projection gate as `$1` so every filter inherits the
  receipt-pinned scope. Filters: `sourceTools`, `projectIds`,
  `storeIds`, `since`, `until`, `q` (title substring).
- `apps/api/src/v2/reads/sessions/list.ts` — `listSessions(deps,
  tenantId, input)`. Conflict-resolved inner CTE collapses
  cross-store duplicates by `(source_tool, source_session_id)`
  taking the freshest `end_ts` then highest `receipt_id`; outer
  query re-sorts by `start_ts DESC, session_id DESC` and applies
  the opaque base64url cursor over `{ startedAt, id }`.
- `apps/api/src/v2/reads/sessions/count.ts` — `countSessions(deps,
  tenantId, input)`. Re-uses `buildSessionWhere`; collapses
  cross-store duplicates with `SELECT DISTINCT (source_tool,
  source_session_id)` so the count agrees with what a paginated
  list iteration would surface.
- `apps/api/src/v2/reads/sessions/detail.ts` — `getSessionDetail`.
  Returns the header for a current session and gate-aware counts
  for messages / tool calls / tool-result errors / content blocks /
  events / artifacts. Each count subquery composes the gate so
  superseded auxiliary rows stay hidden.
- `POST /v2/reads/sessions/list`, `POST /v2/reads/sessions/count`,
  `POST /v2/reads/sessions/detail` registered in
  `registerV2ReadRoutes` with Zod input validation. The shared
  `requireV2Tenant` gate keeps the 401 / 403 / 400 ladder
  consistent with the authority refresh route.
- `apps/api/src/v2/reads/shared/verified-projection.ts` —
  CQ-141-style fix: rename the inner `remote_authority_v2` alias to
  `ra_gate` so a projection table aliased `a` (used by
  `projection_artifact` reads) does not shadow it.
- `apps/api/test/v2/reads/sessions-list.test.ts` (9 tests) drives the
  handler functions against a fresh v2-only PGlite per case. Covers
  empty-tenant short-circuit, gate hiding superseded rows, cursor
  stability across pages, cross-store conflict resolution, every
  filter combination, tenant isolation, count collapsing, detail
  found / not-found, and gate-aware count totals.
- `lint-no-direct-projection-read.test.ts` updated to accept the
  `buildSessionWhere` helper as a known gate composer so the list /
  count handlers stay flagged when they would otherwise hit a
  projection table directly.

Slice 2 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 4 files / 23/23 tests passed
pnpm typecheck                         → EXIT=0
pnpm --filter @c3-oss/prosa-api lint   → EXIT=0
```

Remaining slices (per `docs/rearch-2/07-lane-6-read-api.md`):

1. Sessions transcript pagination with bounded inline text.
2. Search query with FTS, snippets, filters.
3. Tool-calls list and artifacts.getText.
4. Analytics summary/report and cross-store aggregation.
5. p95 latency evidence under fixture load.
6. Five consecutive 180 s stabilization cycles before RALPH_DONE.

## Scope

Lane 6 implements the receipt-pinned remote read API from
`docs/rearch-2/07-lane-6-read-api.md`.

Core scope:

- Authority refresh endpoint for store authority and 30 s cache TTL behavior.
- Sessions list/count/detail/transcript reads.
- Search query using Postgres FTS.
- Tool-calls list.
- Artifacts getText with verified projection and receipt/object grant checks.
- Analytics summary/report.
- Query-time cross-store aggregation and deterministic conflict resolution.
- Shared verified-projection/authority gate for every read path.

Required support:

- Focused route/handler tests under `apps/api/test/v2/reads/`.
- Fixtures for tenant/store/receipt/projection/search rows.
- Cache/performance smoke evidence for the Lane 6 p95 targets.
- Lint or integration checks that prove read paths do not bypass the shared
  gate.

Premature/later-lane surface:

- Lane 7 CLI/MCP read consumers.
- Web console pages.
- Lane 8 audit/GC implementation.
- Lane 10 v1/v2 table cutover or broad schema renames unless required to make
  a Lane 6 read route executable and proven by smoke evidence.

## Initial Gates

```text
pnpm --filter @c3-oss/prosa-api test
pnpm typecheck
pnpm lint
git diff --check
```

Lane-specific evidence still to collect:

- `apps/api/test/v2/reads/authority-refresh.test.ts`
- `apps/api/test/v2/reads/verified-projection-gate.test.ts`
- `apps/api/test/v2/reads/sessions-list.test.ts`
- `apps/api/test/v2/reads/search-fts.test.ts`
- `apps/api/test/v2/reads/transcript-pagination.test.ts`
- `apps/api/test/v2/reads/artifacts-get-text.test.ts`
- `apps/api/test/v2/reads/analytics-report.test.ts`
- `apps/api/test/v2/reads/cross-store-distinct.test.ts`
- latency/cache smoke showing the Lane 6 p95 targets.
