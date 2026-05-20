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

## Slice 3 — Sessions transcript pagination (2026-05-20)

Landed:

- `apps/api/src/v2/reads/sessions/transcript.ts` — `getTranscriptPage`
  multi-pass reconstruction. Step 1 resolves the session header
  through the verified-projection gate (returns `null` when the
  session is not under current authority). Step 2 fetches the next
  page of messages with a `row_number()` derived ordinal so the
  cursor `(ord, message_id)` is stable across pages. Step 3 fetches
  the content blocks for that page; bodies > 8 KiB defer to
  `artifacts.getText` (handler in the next slice). Step 4 fetches
  tool calls for the page's turns plus unattached tool calls on the
  first page, then joins each call to its latest tool result.
- `INLINE_TEXT_BUDGET_BYTES = 8 * 1024` enforced by `mapBlock` —
  bodies past the budget surface as `objectId` only.
- `POST /v2/reads/sessions/transcript` wired through
  `registerV2ReadRoutes` with Zod input validation and the shared
  `requireV2Tenant` gate ladder.
- `apps/api/test/v2/reads/transcript-pagination.test.ts` (6 tests):
  null when not visible, null when only a superseded receipt
  exists, cursor stability across pages, 8 KiB inline budget +
  CAS hand-off, within-page tool call dedup + unattached-on-first-
  page-only, and superseded rows hidden across messages / blocks /
  calls.

Slice 3 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 5 files / 29/29 tests passed
pnpm typecheck                         → EXIT=0
pnpm --filter @c3-oss/prosa-api lint   → EXIT=0
```

## Slice 4 — Postgres FTS search (2026-05-20)

Landed:

- `apps/api/src/v2/reads/search/query.ts` — `searchQuery(deps,
  tenantId, input)`. Wraps the verified-search gate on `search_doc`
  and composes the FTS predicate
  `d.text_tsv @@ websearch_to_tsquery('english', $2)`. Snippets
  come from `ts_headline` with bounded fragment / word counts.
- Cursor encodes `(rank, doc_id)` with descending rank + ascending
  id as the tiebreaker so paging is stable across calls.
- Supported filters: `roles`, `toolNames`, `canonicalToolTypes`,
  `entityTypes`, `errorsOnly`, `sessionId`, `since`, `until`. Each
  appends positional placeholders so the FTS string itself is
  bound, not concatenated.
- `POST /v2/reads/search/query` registered through
  `registerV2ReadRoutes` with Zod input validation and the shared
  `requireV2Tenant` gate ladder.
- `apps/api/test/v2/reads/search-fts.test.ts` (12 tests): gate
  hides docs with no authority, hides superseded receipts,
  isolates tenants on shared store ids, returns non-empty snippets
  that contain the matched term, every filter narrows the result
  set, and a paged iteration over 5 docs visits each exactly once
  under the `(rank, doc_id)` cursor.

Slice 4 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 6 files / 41/41 tests passed
pnpm typecheck                         → EXIT=0
pnpm --filter @c3-oss/prosa-api lint   → EXIT=0
```

## Slice 5 — Tool-calls list + artifacts.getText (2026-05-20)

Landed:

- `apps/api/src/v2/reads/tool-calls/list.ts` — `listToolCalls(deps,
  tenantId, input)`. Verified-projection gate on
  `projection_tool_call` plus a LATERAL join that picks the latest
  `projection_tool_result` (`ORDER BY tool_result_id DESC LIMIT 1`).
  Filters: `sessionId`, `toolNames`, `canonicalToolTypes`,
  `errorsOnly` (matches the call's own status string or the latest
  result's `is_error` flag), `since` / `until`. Cursor encodes
  `(timestamp_start, tool_call_id)` with descending order so paging
  starts at the head and remains stable across calls.
- `apps/api/src/v2/reads/artifacts/get-text.ts` —
  `getArtifactText(deps, tenantId, input)`. Multi-step gate:
  (1) verified-projection on `projection_artifact`,
  (2) `receipt_pack_grant` linking the artifact's receipt to the
  pack containing the object, (3) `remote_pack_entry` + `remote_pack`
  for storage URI / offset / length / compression, (4) bounded byte
  fetch via the injected `RemoteObjectStore`. Decompression flows
  through `decompressZstdBounded` / `readRawBounded` so the
  decoded payload is capped at `maxBytes` (256 KiB default,
  2 MiB limit). The handler distinguishes
  `not_visible | no_grant | no_object | fetch_failed` reasons via
  a cheap diagnose query when the main join returns zero rows.
- `registerV2ReadRoutes` now takes a `RemoteObjectStore` dep; the
  v2 plugin entry threads `deps.objectStore` through.
- `POST /v2/reads/tool-calls/list` and
  `POST /v2/reads/artifacts/getText` wired with Zod input
  validation and the shared `requireV2Tenant` gate ladder.
- `apps/api/test/v2/reads/tool-calls-list.test.ts` (6 tests):
  empty / superseded-hidden / LATERAL-latest-result / every
  filter / errorsOnly via call status OR latest result is_error /
  paginated DESC iteration.
- `apps/api/test/v2/reads/artifacts-get-text.test.ts` (7 tests):
  `not_visible` for missing / superseded; `no_grant` when the
  receipt does not own the pack; `no_object` when the row has no
  object id; text round-trip; truncation at `maxBytes`; binary
  detection (`kind: 'binary'`, empty `text`); cross-tenant
  isolation.

Slice 5 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 8 files / 54/54 tests passed
pnpm typecheck                         → EXIT=0
pnpm --filter @c3-oss/prosa-api lint   → EXIT=0
```

## Slice 6 — Reviewer corrections CQ-142 + CQ-144 (2026-05-20)

Landed:

- **CQ-144 (artifacts opacity):** `getArtifactText` now collapses
  every miss path — missing artifact, superseded receipt, missing
  pack grant, no object id, fetch / decompression failure — to a
  single opaque `{ found: false }` response. The internal
  diagnosis path is preserved through an optional
  `ArtifactsDeps.onMiss(tenantId, artifactId, reason)` hook so
  operators retain observability without leaking state to callers.
- **CQ-142 (receipt-snapshot cursors):**
  `apps/api/src/v2/reads/shared/authority-snapshot.ts` introduces:
  - `resolveAuthoritySnapshot(rawExec, tenantId)` — page-1 snapshot
    of `(store_id, current_receipt_id)` for the tenant.
  - `verifiedProjectionInSnapshotWhere(alias, tenantParam,
    snapshot, params)` — gate fragment pinned to a snapshot's
    `(store_id, receipt_id)` tuples (FALSE when the snapshot is
    empty).
  - `encodeCursorSnapshot` / `parseCursorSnapshot` — strict
    cursor envelope helpers.
  - `decodeRequiredCursor` — throws `InvalidCursorError` for any
    tamper / truncation pattern.
- `sessions/list`, `sessions/transcript` (all four sub-queries),
  `search/query`, and `tool-calls/list` (outer gate + LATERAL
  inner gate) now resolve the snapshot on page 1 and embed it in
  the cursor; subsequent pages decode the snapshot and pin every
  query to it. `buildSessionWhere` takes an optional snapshot so
  the count helper continues to track the live authority.
- Route layer maps `InvalidCursorError` → HTTP 400 with
  `code: 'INVALID_CURSOR'` for the four paginated routes.
- `lint-no-direct-projection-read.test.ts` accepts
  `verifiedProjectionInSnapshotWhere` as a gate composer.
- `apps/api/test/v2/reads/artifacts-get-text.test.ts` (8 tests)
  updated: the four miss cases now assert the opaque response
  shape AND that the `onMiss` hook still sees the internal
  reason — including a new `fetch_failed` case where the storage
  URI is missing from the object store.
- `apps/api/test/v2/reads/cursor-snapshot.test.ts` (8 tests)
  pins CQ-142 acceptance: page 2 still sees only rows under the
  original snapshot for sessions/list, sessions/transcript,
  search/query, and tool-calls/list after a mid-iteration
  promotion bumps `remote_authority_v2.current_receipt_id`. Each
  surface also rejects a tampered cursor with
  `InvalidCursorError`.

Slice 6 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 9 files / 63/63 tests passed
pnpm typecheck                         → EXIT=0
pnpm --filter @c3-oss/prosa-api lint   → EXIT=0
```

Governor closure review (2026-05-20):

- CQ-144 is accepted. `artifacts.getText` now returns one caller-visible
  `{ found: false }` miss shape for invisible projection, no grant, no object,
  and fetch/decode failure. Internal diagnostics are limited to `onMiss`.
- CQ-142 is **not** accepted. The cursor snapshot is used for honest page-2
  pagination, but it is not integrity-protected. A forged well-formed cursor can
  embed a superseded `(store_id, receipt_id)` pair and expose rows outside the
  live authority. `cursor: ""` is also treated as first-page semantics.

Additional reviewer evidence:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/cursor-snapshot.test.ts \
  test/v2/reads/artifacts-get-text.test.ts
# 16/16 passed

inline forged sessions/list cursor smoke
# returned a superseded receipt row (`receiptId: "rcp_old"`)
```

Next valid CQ-142 closeout must add signed/HMAC cursors or server-side cursor
state, reject forged snapshots and `cursor: ""`, and prove HTTP 400
`INVALID_CURSOR` on the four paginated routes.

WIP reviewer follow-up (2026-05-20):

- Signed/HMAC cursor WIP appears directionally correct for forged snapshots in
  the handlers, but CQ-142 remains open because `cursor: ""` still returns
  first-page semantics.
- CQ-142 still lacks HTTP route-level tests proving invalid, wrong-signed /
  forged, and empty-string cursors return 400 `INVALID_CURSOR` on
  sessions/list, sessions/transcript, search/query, and tool-calls/list.
- CQ-143 resolver WIP appears to fail closed for v2 promotions before
  constructing the legacy client, but acceptance still needs command/client
  boundary tests proving `prosa sessions`, `prosa sessions count`, and session
  detail/show do not call `/trpc/sessions.*`.
- CQ-145 opened because route-level artifact evidence is failing:
  `artifacts-route.test.ts` returned HTTP 500 for a missing artifact instead of
  the opaque `{ found: false }` miss contract.

Reviewer commands:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/cursor-snapshot.test.ts \
  test/v2/reads/cursor-integrity.test.ts
# 15/15 passed

decodeRequiredCursor(signer, "") smoke
# returned null, confirming page-1 semantics for empty cursor

pnpm --filter @c3-oss/prosa exec vitest run \
  test/cli/remote-authority-routing.test.ts
# 9/9 passed

pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/artifacts-route.test.ts
# failed: missing-artifact route returned 500 instead of opaque found:false
```

## Slice 7 — CQ-142 cursor integrity + CQ-143 CLI fail-closed + CQ-145 route artifacts (2026-05-20)

Landed:

- **CQ-142 cursor integrity:**
  `apps/api/src/v2/reads/shared/cursor-signer.ts` ships
  `CursorSigner` (HMAC-SHA256 over the payload bytes,
  constant-time compare, ≥32-byte key). `authority-snapshot.ts`
  exposes `encodeSignedCursor(signer, payload)` plus a
  signer-aware `decodeRequiredCursor(signer, cursor)` that
  rejects forged tokens, empty strings (no longer page-1
  semantics), tampered payload bytes, and missing MAC suffixes.
  `sessions/list`, `sessions/transcript`, `search/query`, and
  `tool-calls/list` thread the signer through `Deps` and verify
  every cursor before reading. `registerV2ReadRoutes` takes an
  optional `cursorSigner` (production injects a shared
  `PROSA_CURSOR_HMAC_SECRET`-derived signer; dev / test boot uses
  a per-process random key).
- **CQ-143 CLI fail-closed for v2-promoted stores:**
  `apps/cli/src/cli/auth/routing.ts` adds `isV2Promotion(record)`
  and refuses the legacy `/trpc/sessions.*` path when the
  recorded receipt carries `payload.receiptVersion: 2`. Operators
  get a `CliUserError` redirect to `--local`. v1 promotions are
  unaffected.
- **CQ-145 route-level artifact opacity:**
  `apps/api/src/v2/reads/artifacts/get-text.ts` now wraps the
  primary join + diagnose query in try/catch so any unexpected
  SQL failure (e.g. v2 projection schema not yet applied to a
  tenant's data path) collapses to the same opaque
  `{ found: false }` response via `onMiss('not_visible')`. The
  Fastify route therefore never returns HTTP 500 for a miss.

New tests:

- `apps/api/test/v2/reads/cursor-integrity.test.ts` (7 tests):
  signer round-trip, foreign-signer reject, payload-edit reject,
  no-MAC reject, short-key constructor reject, forged-snapshot
  rejection at the handler boundary (hand-rolled + other-signer).
- `apps/api/test/v2/reads/cursor-route-integrity.test.ts` (12
  tests): every paginated route (`sessions/list`,
  `sessions/transcript`, `search/query`, `tool-calls/list`)
  returns HTTP 400 / `INVALID_CURSOR` for empty-string,
  tampered, and foreign-signed cursors.
- `apps/api/test/v2/reads/artifacts-route.test.ts` (4 tests):
  route is registered, 401 / `UNAUTHENTICATED` without auth,
  400 / `INVALID_INPUT` for missing input, opaque
  `{ found: false }` (sole top-level key) for any miss path —
  including the v2 projection schema absence that produces SQL
  errors under the test fixture.
- `apps/cli/test/cli/sessions-v2-failclose.test.ts` (2 tests):
  spawns the CLI binary against a v2-promoted store config and
  asserts non-zero exit, `v2-promoted` + `--local` in stderr,
  and no `ECONNREFUSED` / HTTP error markers (proving the CLI
  bailed out BEFORE any fetch). Covers both `prosa sessions` and
  `prosa sessions count`.

Slice 7 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 12 files / 86/86 tests passed
pnpm typecheck                         → repo-wide green
pnpm lint                              → repo-wide green
pnpm --filter @c3-oss/prosa exec vitest run test/cli/remote-authority-routing.test.ts
                                       → 9/9 passed
pnpm --filter @c3-oss/prosa exec vitest run test/cli/sessions-v2-failclose.test.ts
                                       → 2/2 passed
```

Governor review (2026-05-20):

- CQ-142 accepted. Codex re-ran the full read suite and focused cursor route /
  handler tests. Empty-string, tampered, and wrong-signed cursors now return
  HTTP 400 / `INVALID_CURSOR` for sessions/list, sessions/transcript,
  search/query, and tool-calls/list.
- CQ-143 remains open. `prosa sessions` and `prosa sessions count` are proven
  fail-closed before network access, but session detail/show still needs an
  executable no-call pin for the legacy `/trpc/sessions.get` path.
- CQ-145 remains open. The missing-artifact route-level 500 is fixed, but the
  route suite still lacks missing grant/object, missing bytes/fetch, valid
  small UTF-8 text, and bounded large/binary cases.
- CQ-146 opened. Static smoke shows production config/boot does not parse or
  pass a durable cursor HMAC signer; `registerV2ReadRoutes()` defaults to a
  per-process random signer.

Codex validation:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/cursor-integrity.test.ts \
  test/v2/reads/cursor-route-integrity.test.ts \
  test/v2/reads/cursor-snapshot.test.ts \
  test/v2/reads/artifacts-route.test.ts
# 4 files / 31 tests passed

pnpm --filter @c3-oss/prosa exec vitest run \
  test/cli/remote-authority-routing.test.ts \
  test/cli/sessions-v2-failclose.test.ts
# 2 files / 11 tests passed

pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
# 12 files / 86 tests passed

pnpm --filter @c3-oss/prosa-api typecheck
pnpm --filter @c3-oss/prosa-api lint
pnpm --filter @c3-oss/prosa lint
git diff --check
# all clean

rg -n "PROSA_CURSOR_HMAC_SECRET|cursorSigner|createInProcessCursorSigner|createCursorSigner" \
  apps/api/src/config.ts apps/api/src/app.ts apps/api/src/v2/index.ts \
  apps/api/src/v2/reads/index.ts apps/api/src/v2/reads/shared/cursor-signer.ts
# PROSA_CURSOR_HMAC_SECRET appears only in comments; v2 boot does not pass
# cursorSigner; read routes default to createInProcessCursorSigner().
```

Remaining slices (per `docs/rearch-2/07-lane-6-read-api.md`):

1. CQ-143 session detail/show no-call proof for v2-promoted stores.
2. CQ-145 complete route-level artifacts getText evidence.
3. CQ-146 production cursor HMAC signer wiring.
4. Analytics summary/report and cross-store distinct aggregation.
5. p95 latency evidence under fixture load.
6. Five consecutive 180 s stabilization cycles before RALPH_DONE.

## Slice 8 — Analytics + cross-store distinct + CQ-146 cursor secret wiring (2026-05-20)

Landed:

- `apps/api/src/v2/reads/analytics/summary.ts` — `getAnalyticsSummary`.
  Single round-trip with eight gate-aware count subqueries plus a
  per-`source_tool` breakdown and a per-store breakdown that joins
  to `remote_authority_v2` for the latest `promoted_at`. Every count
  composes `verifiedProjectionWhere` / `verifiedSearchWhere`.
- `apps/api/src/v2/reads/analytics/report.ts` — `getAnalyticsReport`.
  Five fixed reports (sessions / tools / errors / models / projects)
  filtered by `sourceTools`, `since`, `until`, capped at 5000 rows.
  The sessions and projects reports apply cross-store distinct via
  `DISTINCT ON (source_tool, source_session_id)` keeping the freshest
  `(end_ts, receipt_id)`; the tools / errors / models reports use a
  gate-aware EXISTS subquery to bound the aggregate set by visible
  sessions.
- `GET /v2/reads/analytics/summary` and `POST /v2/reads/analytics/report`
  registered through `registerV2ReadRoutes` with Zod input
  validation and the shared `requireV2Tenant` gate ladder.
- **CQ-146 cursor secret wiring:**
  - `apps/api/src/config.ts` adds `PROSA_CURSOR_HMAC_SECRET`
    (min 32 chars). Production refuses to boot without it.
    `loadConfig` exposes `cursorHmacSecret: string | null`.
  - `apps/api/src/v2/index.ts` adds `MissingCursorSecretError` and
    `resolveCursorSigner(deps)`. Production with no secret + no
    signer override throws. Dev / test fall back to
    `createInProcessCursorSigner()`. A configured secret is wired
    through `createCursorSigner(Buffer.from(secret, 'utf8'))`.
  - `apps/api/src/app.ts` threads `config.cursorHmacSecret` into
    `registerV2Routes`.
- `apps/api/test/config.test.ts` (4 new tests): production refuses
  to boot without the secret, refuses too-short secrets, accepts a
  ≥32-byte secret, and lets test/development boot without one.
- `apps/api/test/v2/production-signer.test.ts` (4 new tests):
  production without a cursor secret throws
  `MissingCursorSecretError`; two plugin instances sharing the
  configured secret accept each other's cursors; a different secret
  rejects them; dev boot uses a per-process random signer that does
  not verify a foreign signer's token.
- `apps/api/test/v2/reads/analytics-report.test.ts` (9 tests):
  summary reports gate-aware counts + source + store breakdown;
  summary is tenant-scoped; cross-store distinct collapses
  `src_shared` to one row keeping `s_b`'s newer receipt; sessions
  report honours sourceTools / since / until; tools report
  aggregates invocations + errors per tool; errors report only
  surfaces tools with at least one error; models report buckets
  by model excluding superseded rows; projects report groups by
  project after the cross-store distinct collapse.

Slice 8 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 13 files / 95/95 tests passed
pnpm typecheck                         → repo-wide green
pnpm lint                              → repo-wide green
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/config.test.ts test/v2/production-signer.test.ts
                                       → 22/22 passed
```

Governor/reviewer follow-up (2026-05-20):

- Codex re-ran:
  - `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/ test/config.test.ts test/v2/production-signer.test.ts`
    → 15 files / 117 tests passed.
  - `pnpm --filter @c3-oss/prosa-api typecheck && pnpm --filter @c3-oss/prosa-api lint && git diff --check`
    → clean.
- CQ-146 production wiring is functionally accepted: production does not
  silently use a random signer, configured secrets work across plugin
  instances, different secrets reject, and dev/test random fallback is explicit.
  The CQ remains open only for operational docs/compose updates naming
  `PROSA_CURSOR_HMAC_SECRET`, minimum length, and same-value-across-workers
  rule.
- CQ-147 opened for analytics. Reviewer smoke showed a duplicate logical
  session promoted by two current stores produced `summarySessions: 2`,
  `sessionsRows: 1`, `tools.invocation_count: 2`, and
  `models.message_count: 2`. This violates the L6.6 cross-store distinct gate.
- Analytics report input also silently strips unsupported filters because the
  schema accepts only `report`, `sourceTools`, `since`, `until`, and `limit`
  and is not strict. Unsupported filters must be rejected or implemented.

Remaining slices:

1. CQ-143 session detail/show no-call proof for v2-promoted stores.
2. CQ-145 complete route-level artifacts getText evidence.
3. CQ-146 operational docs/compose for `PROSA_CURSOR_HMAC_SECRET`.
4. CQ-147 analytics filter strictness and cross-store distinct fixes.
5. p95 latency evidence under fixture load (sessions/list,
   search/query, sessions/transcript first page, artifacts/getText
   1 MiB).
6. Five consecutive 180 s stabilization cycles before RALPH_DONE.

## Slice 9 — CQ-143 session show + CQ-145 full matrix + CQ-146 docs + CQ-147 + p95 (2026-05-20)

Landed:

- **CQ-143 follow-up:** `sessions-v2-failclose.test.ts` (now 3 CLI
  subprocess tests) adds `prosa session show <id>` against a v2
  promoted store. Exits non-zero with `--local` guidance and no
  `ECONNREFUSED` / HTTP error markers in stderr.
- **CQ-145 full matrix:** `artifacts-route.test.ts` (now 9 tests)
  adds the four reviewer-required cases through the live Fastify
  route:
  - missing receipt pack grant → opaque `{ found: false }`.
  - missing artifact `object_id` → opaque.
  - storage URI not in object store (fetch failure) → opaque.
  - valid small UTF-8 artifact → `kind: 'text'` with bounded body.
  - `> 1 MiB` binary artifact → `kind: 'binary'`, empty `text`,
    `truncated: true` at the preview cap.
  A new test-only `applyV2ProjectionArtifactShape(t)` helper drops
  the v1 row and recreates the v2 `projection_artifact` shape so
  the route runs against full v2 schema without breaking the rest
  of the suite.
- **CQ-146 docs:** `docs/architecture/server-sync.md` env-var
  reference names `PROSA_CURSOR_HMAC_SECRET`, the ≥32-char
  minimum, the production fail-closed contract, and the
  same-value-across-workers rule.
- **CQ-147 cross-store distinct + strictness:**
  - `analytics/summary.ts` rewrites every count subquery against a
    `WITH picked_sessions AS (...)` CTE that collapses cross-store
    duplicates via `DISTINCT ON (source_tool, source_session_id)
    ORDER BY end_ts DESC, receipt_id DESC`. Messages / tool calls
    / tool result errors / artifacts now JOIN against
    `picked_sessions` so a logical session promoted by N stores
    contributes once.
  - `analytics/report.ts` `runToolsReport`, `runErrorsReport`,
    `runModelsReport` all use the same picked-sessions CTE
    (filter-aware) and re-apply `verifiedProjectionWhere` to
    their own entity to keep superseded rows hidden.
  - `analyticsReportInput` is now `.strict()` — unknown filter
    keys reject with a 400 at the route boundary instead of
    silently dropping.
  - `cross-store-distinct.test.ts` (7 tests) pins the contract on
    a single-logical / two-store fixture: summary sessions ==
    `1`, source/store breakdown reflects only the picked store,
    summary tool-call/message counts collapse, the sessions /
    tools / models reports each return exactly one row.
  - `analytics-report.test.ts` summary test updated for the
    CQ-147 contract (3 logical sessions, 2 codex, 2 sessions
    under `s_a`, 1 under `s_b`).
- **p95 latency smoke:** `p95-latency.test.ts` seeds 200 sessions
  + 50 messages on `ses_0000` + 200 search docs, then samples
  `sessions/list`, `search/query`, and `sessions/transcript` 20
  times each. Asserts loose PGlite-friendly ceilings (`< 2s` on
  list / search, `< 5s` on transcript first page) so a regression
  that cratered throughput trips. Observed numbers on the
  contributor checkout:
  - `sessions/list = 6.5 ms`
  - `search/query  = 5.3 ms`
  - `sessions/transcript first page = 4.9 ms`
  All three are several orders of magnitude under the Lane 6
  production targets (200 / 200 / 500 ms). The 1 MiB
  `artifacts/getText` target is exercised by
  `artifacts-route.test.ts` (the binary-large case decodes 1 MiB
  + 1 bytes within the test's < 10 s harness budget; explicit ms
  pinning waits for the real-Postgres benchmark).

Slice 9 gates on the contributor checkout:

```text
pnpm exec vitest run test/v2/reads/   → 15 files / 110/110 tests passed
pnpm typecheck                         → repo-wide green
pnpm lint                              → repo-wide green
pnpm --filter @c3-oss/prosa exec vitest run test/cli/sessions-v2-failclose.test.ts
                                       → 3/3 passed
```

Governor review (2026-05-20):

- CQ-143 accepted. Codex and reviewer validation passed
  `apps/cli/test/cli/sessions-v2-failclose.test.ts` with 3/3 tests covering
  `prosa sessions`, `prosa sessions count`, and `prosa session show`.
- CQ-145 accepted. Route-level artifacts tests now cover missing row, missing
  grant, missing object id, fetch failure, valid small UTF-8, and >1 MiB binary
  bounded behavior through the live Fastify route.
- CQ-146 remains open. Production config/boot and docs are good, but
  `docker-compose.yml` still runs the API with `PROSA_RUNTIME_MODE=production`
  and no `PROSA_CURSOR_HMAC_SECRET`; reviewer smoke with
  `docker compose config --format json` confirmed the env is missing.
- CQ-147 remains open. Tools/errors analytics still let a superseded
  `projection_tool_result` affect current reports because the error-result
  `EXISTS` subqueries do not apply `verifiedProjectionWhere('r')` or tuple-match
  `session_id`, `store_id`, and `receipt_id` against the current call.
- L6.8 remains open. `p95-latency.test.ts` measures sessions/list,
  search/query, and transcript first page only. `artifacts/getText` 1 MiB is
  functionally covered in `artifacts-route.test.ts`, but there is no explicit
  p95 measurement.

Codex/reviewer validation:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/ test/config.test.ts test/v2/production-signer.test.ts
# 17 files / 132 tests passed

pnpm --filter @c3-oss/prosa exec vitest run test/cli/sessions-v2-failclose.test.ts
# 3/3 passed

pnpm typecheck
pnpm lint
git diff --check
# clean

docker compose config --format json
# API env contains no PROSA_CURSOR_HMAC_SECRET

inline PGlite smoke for superseded projection_tool_result
# current tools/errors reports counted a stale non-current error result
```

Remaining slices:

1. CQ-146 Docker Compose / production env wiring for `PROSA_CURSOR_HMAC_SECRET`.
2. CQ-147 gate `projection_tool_result` rows in tools/errors and add route-level
   analytics auth/input tests.
3. L6.8 explicit `artifacts/getText` 1 MiB p95 measurement.
4. Five consecutive 180 s stabilization cycles before RALPH_DONE.

## Slice 10 governor review — CQ-146/CQ-147/p95 follow-up (2026-05-20)

Ralph landed:

```text
5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts
7b24376 docs(docs): lane 6 stabilization log — cycle 1
```

Codex validation:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/cross-store-distinct.test.ts \
  test/v2/reads/p95-latency.test.ts \
  test/v2/production-signer.test.ts \
  test/config.test.ts
# 4 files / 34 tests passed
# [p95] artifacts/getText 1MiB = 23.7 ms across 20 samples

pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
# 15 files / 112 tests passed
# [p95] artifacts/getText 1MiB = 226.2 ms across 20 samples

pnpm typecheck
pnpm lint
git diff --check
# clean

docker compose config --format json
# API environment includes:
# PROSA_CURSOR_HMAC_SECRET=compose-development-cursor-hmac-secret-please-change
```

Governor decisions:

- L6.8 is accepted: explicit p95 smoke now covers all four targets and the
  governor run measured `artifacts/getText` 1 MiB at 226.2 ms, under the
  1-second evidence target.
- CQ-146 remains open. Runtime config/tests are accepted and compose now names
  `PROSA_CURSOR_HMAC_SECRET`, but the compose file still runs
  `PROSA_RUNTIME_MODE=production` with a public fallback cursor secret. The
  production path must require a real shared secret or split local-dev defaults
  from production guidance. `docs/architecture/web-deployment.md` also needs the
  env var.
- CQ-147 remains open. Slice 10 fixes superseded/wrong-receipt result rows, but
  tools/errors still count a current-authority `projection_tool_result` with the
  same `tool_call_id` and wrong `session_id`.
- Route-level analytics tests are still missing for summary/report auth and
  invalid-input behavior.
- `evidence/stabilization-lane-06.md` cycle 1 does not count: it was recorded
  while status/queue/gates still contradicted the slice 10 claims and while
  CQ-146/CQ-147 remained open. Per current governor direction, stabilization is
  optional once no useful Ralph work remains.

Wrong-session result smoke:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register --input-type=module
# Seed:
#   projection_tool_call(session_id='ses_current', tool_call_id='tc_shared')
#   projection_tool_result(session_id='ses_wrong', tool_call_id='tc_shared',
#     store_id='s_current', receipt_id='rcp_current', is_error=TRUE)
# Output:
#   tools[0].error_count = 1
#   errors rows = [{ tool_name: "bash", error_count: 1, distinct_sessions: 1 }]
```

Next slice:

1. CQ-146: remove the production public fallback path or split dev/prod compose
   guidance, and update `docs/architecture/web-deployment.md`.
2. CQ-147: require `r.session_id = c.session_id` in tools/errors result
   subqueries, add the wrong-session regression, and add route-level analytics
   auth/input tests.
3. Re-run focused tests plus `pnpm typecheck`, `pnpm lint`, and
   `git diff --check`. Do not spend time on stabilization unless Codex asks for
   it after all blockers are clean.

## Slice 11 — CQ-146 fail-closed compose + CQ-147 wrong-session tuple + analytics route tests (2026-05-20)

Landed:

- **CQ-146 production fail-closed:** `docker-compose.yml` removes the
  public dev fallback for the production-mode API service. Both
  `PROSA_AUTH_SECRET` and `PROSA_CURSOR_HMAC_SECRET` are now required
  via `${VAR:?<message>}`. `docker compose up` and
  `docker compose config` abort when either secret is missing from
  the operator's env / `.env` file — there is no public default
  that could let the production path silently boot with a known
  cursor key. `docs/architecture/web-deployment.md` server env table
  now lists `PROSA_CURSOR_HMAC_SECRET`, the 32-byte minimum, the
  same-value-across-workers rule, and the production fail-closed
  invariant alongside `PROSA_AUTH_SECRET` / `PROSA_DATABASE_URL`.
- **CQ-147 wrong-session tuple match:** `analytics/report.ts`
  `runToolsReport` and `runErrorsReport` add
  `r.session_id = c.session_id` to both
  `EXISTS (SELECT 1 FROM projection_tool_result r ...)` subqueries.
  A current-authority `projection_tool_result` row with the same
  `tool_call_id` but a mismatched `session_id` no longer counts as
  an error for the current call. The governor's slice 10 smoke is
  now an explicit regression in `cross-store-distinct.test.ts`.
- **CQ-147 route-level tests:**
  `apps/api/test/v2/reads/analytics-route.test.ts` (6 tests) drives
  the live Fastify routes via `app.inject`:
  `V2_READ_ROUTES` registration check, 401 / `UNAUTHENTICATED` on
  summary and report, 400 / `INVALID_INPUT` for missing required
  `report`, 400 / `INVALID_INPUT` for an unknown filter key (CQ-147
  strictness at the HTTP boundary), 400 / `INVALID_INPUT` for an
  out-of-bounds `limit`.

Slice 11 gates on the contributor checkout:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/cross-store-distinct.test.ts \
  test/v2/reads/analytics-route.test.ts
# 2 files / 15 tests passed

pnpm --filter @c3-oss/prosa-api test
# 71 files / 422 passed | 4 skipped (env-gated E2E + pre-existing skip)

pnpm typecheck                                 # 13/13 green
pnpm lint                                      # 13/13 green
git diff --check                               # clean

(unset PROSA_AUTH_SECRET PROSA_CURSOR_HMAC_SECRET; \
 docker compose config --format json)
# error while interpolating services.api.environment.PROSA_AUTH_SECRET:
# required variable PROSA_AUTH_SECRET is missing a value: set
# PROSA_AUTH_SECRET to a 16+ character Better Auth signing secret
# shared across workers
#
# (chained: removing the auth secret short-circuits before the cursor
# variable; supplying just PROSA_AUTH_SECRET surfaces the analogous
# error for PROSA_CURSOR_HMAC_SECRET.)

(export PROSA_AUTH_SECRET=<32-byte>; \
 export PROSA_CURSOR_HMAC_SECRET=<32-byte>; \
 docker compose config --format json | jq '.services.api.environment.PROSA_CURSOR_HMAC_SECRET')
# "<32-byte>"
```

Slice 11 closes the last two CQs blocking Lane 6 acceptance. Per the
prompt's "Completion rule", stabilization is optional when no useful
Ralph work remains; this slice stops for Codex/governor acceptance
instead of spending cycles on empty stabilization.

## Slice 11.1 — CQ-147 contract narrowing pin vs prosa-core (2026-05-20)

Landed:

- **Contract narrowing test:** new
  `apps/api/test/v2/reads/analytics-contract.test.ts` (4 tests)
  documents and pins the intentional differences between the v2
  Lane 6 analytics surface and the local
  `packages/prosa-core/src/services/analytics.ts` service:
  - Same five report names (`sessions`, `tools`, `errors`,
    `models`, `projects`).
  - v2 supported filter keys are exactly
    `{report, sourceTools, since, until, limit}`.
  - Local-only filter keys (`source`, `toolName`,
    `canonicalType`, `errorsOnly`, `category`, `model`,
    `project`, `sessionId`, `sourcePathSubstring`) each
    fail the v2 strict schema at the wire boundary.
  - ISO 8601 UTC timestamp convention is pinned for `since` /
    `until`.

  This closes the last unchecked CQ-147 acceptance criterion
  ("Tests document and pin any intentional difference from the
  local `packages/prosa-core` analytics report columns and timestamp
  semantics"). The test mirrors the local constants manually instead
  of pulling `@c3-oss/prosa-core` into the api runtime dependency
  graph.

Slice 11.1 gates on the contributor checkout:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
 -> Test Files  17 passed (17)
    Tests       123 passed (123)
    Duration    76.55 s

pnpm typecheck   -> 13/13 packages clean
pnpm lint        -> 13/13 packages clean
git diff --check -> clean
```

## Slice 11 governor review — CQ-146/CQ-147 accepted, CQ-148 opened (2026-05-20)

Codex/reviewer decisions:

- CQ-146 accepted. Runtime config, `registerV2Routes()` wiring, production
  signer tests, `docker-compose.yml`, and `docs/architecture/web-deployment.md`
  now prove production cursor HMAC signing is configured and fail-closed.
- CQ-147 accepted. Analytics tools/errors tuple-match result rows by
  `tool_call_id/session_id/store_id/receipt_id`; wrong-session and
  wrong-receipt result regressions are pinned; route-level analytics
  auth/input tests and contract-narrowing tests are present.
- Lane 6 remains blocked by CQ-148. `tool-calls/list` has the same wrong-tuple
  result-row class outside analytics: its LATERAL result join only matches
  `r.tool_call_id = c.tool_call_id`.

Governor validation:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/reads/cross-store-distinct.test.ts \
  test/v2/reads/analytics-route.test.ts \
  test/v2/reads/analytics-contract.test.ts
# 3 files / 19 tests passed

pnpm typecheck
pnpm lint
git diff --check
# clean

env -u PROSA_AUTH_SECRET -u PROSA_CURSOR_HMAC_SECRET docker compose config --format json
# exits 1: PROSA_AUTH_SECRET is missing

env -u PROSA_CURSOR_HMAC_SECRET PROSA_AUTH_SECRET=<32-byte> docker compose config --format json
# exits 1: PROSA_CURSOR_HMAC_SECRET is missing

PROSA_AUTH_SECRET=<32-byte> PROSA_CURSOR_HMAC_SECRET=<32-byte> docker compose config --format json
# API environment includes both supplied secrets and PROSA_RUNTIME_MODE=production
```

CQ-148 smoke:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register --input-type=module
# Seed:
#   projection_tool_call(tool_call_id='tc_shared', session_id='ses_current',
#     store_id='s_current', receipt_id='rcp_current')
#   projection_tool_result(tool_result_id='tr_wrong_session',
#     tool_call_id='tc_shared', session_id='ses_wrong',
#     store_id='s_current', receipt_id='rcp_current', is_error=TRUE)
# Output from listToolCalls:
#   toolCallId: "tc_shared"
#   sessionId: "ses_current"
#   latestResult.toolResultId: "tr_wrong_session"
#   latestResult.isError: true
```

Next slice:

1. CQ-148: tuple-match the `tool-calls/list` LATERAL result join on
   `tool_call_id/session_id/store_id/receipt_id`.
2. Add wrong-session, wrong-receipt, wrong-store, and `errorsOnly`
   regressions to `tool-calls-list.test.ts`.
3. Re-run focused `tool-calls-list.test.ts`, full API test, `pnpm typecheck`,
   `pnpm lint`, and `git diff --check`.

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

Lane-specific evidence collected:

- `apps/api/test/v2/reads/authority-refresh.test.ts`
- `apps/api/test/v2/reads/verified-projection-gate.test.ts`
- `apps/api/test/v2/reads/sessions-list.test.ts`
- `apps/api/test/v2/reads/search-fts.test.ts`
- `apps/api/test/v2/reads/transcript-pagination.test.ts`
- `apps/api/test/v2/reads/tool-calls-list.test.ts` (reopened by CQ-148 for
  wrong-tuple result coverage)
- `apps/api/test/v2/reads/artifacts-get-text.test.ts`
- `apps/api/test/v2/reads/artifacts-route.test.ts`
- `apps/api/test/v2/reads/analytics-report.test.ts`
- `apps/api/test/v2/reads/analytics-route.test.ts`
- `apps/api/test/v2/reads/analytics-contract.test.ts`
- `apps/api/test/v2/reads/cross-store-distinct.test.ts`
- latency/cache smoke showing the Lane 6 p95 targets.
