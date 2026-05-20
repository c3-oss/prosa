# Ralph Loop: rearch-2 Lane 6 read API

## Mission

Continue `rearch-2` after accepted Lane 5 Sync protocol closeout. The next
core milestone is **Lane 6 Read API: receipt-pinned remote reads for authority,
sessions, search, tool calls, artifacts, and analytics**.

Lane 5 is accepted by Codex/governor on 2026-05-20. Do not reopen Lane 5 unless
a fresh smoke command proves a regression that blocks Lane 6. Do not start Lane
7 CLI/MCP read surfaces, Lane 8 audit/GC, or Lane 10 schema cutover work.

## Read first

1. `AGENTS.md`
2. `docs/rearch-2/00-README.md`
3. `docs/rearch-2/07-lane-6-read-api.md`
4. `docs/architecture/server-sync.md`
5. `docs/architecture/search-engines.md`
6. `docs/roadmap/rearch-2/status.md`
7. `docs/roadmap/rearch-2/correction-queue.md`
8. `docs/roadmap/rearch-2/gates.md`
9. `docs/roadmap/rearch-2/evidence/lane-05.md`
10. `docs/roadmap/rearch-2/evidence/stabilization-lane-05.md`
11. `docs/roadmap/rearch-2/evidence/lane-06.md`

## Current milestone

Lane 6 Read API.

Classify all new work against that milestone:

- Core milestone work: `GET /v2/stores/:storeId/authority`,
  `/v2/reads/*` server handlers, shared verified-projection/authority gating,
  sessions list/count/detail/transcript, Postgres FTS search, tool-calls list,
  artifacts.getText, analytics summary/report, cursor encoding, cross-store
  conflict resolution, cache/performance evidence, and focused read-route tests.
- Required support work: read fixtures, tenant/store/receipt/projection/search
  row builders, cache test helpers, SQL helpers, bounded byte fixtures, and
  evidence updates that directly validate Lane 6 gates.
- Premature/later-lane surface: Lane 7 CLI/MCP consumers, web console pages,
  broad dashboards, Lane 8 audit/GC implementation, Lane 10 v1/v2 schema
  cutover/renames, or pure diagnostics that do not directly validate a Lane 6
  read route.

If three consecutive commits are support or later-lane surface without core
Lane 6 progress, stop and redirect to the read API.

## Current corrections and deferrals

Read `docs/roadmap/rearch-2/correction-queue.md` before the next slice.

- CQ-142 is closed and accepted by Codex/governor for cursor integrity,
  receipt-snapshot pagination, empty-cursor rejection, and HTTP-route
  `INVALID_CURSOR` coverage. Do not keep iterating on CQ-142 unless a fresh
  focused smoke command proves a new regression.
- CQ-143 is closed and accepted by Codex/governor. `prosa sessions`,
  `prosa sessions count`, and `prosa session show` fail closed for v2-promoted
  stores with `--local` guidance and no legacy `/trpc/sessions.*` network path.
- CQ-144 is closed and accepted by Codex/governor. `artifacts.getText` now
  returns one opaque `{ found: false }` shape for invisible projection, no
  grant, no object, and fetch/decode failure. Final Lane 6 acceptance still
  needs route-level artifacts evidence.
- CQ-145 is closed and accepted by Codex/governor. Route-level
  `artifacts.getText` evidence covers opaque miss paths, valid small UTF-8
  text, and bounded >1 MiB binary behavior.
- CQ-146 is closed and accepted by Codex/governor. Production config, docs, and
  compose now fail closed for missing `PROSA_CURSOR_HMAC_SECRET`, and the
  production compose path no longer has a public fallback cursor secret.
- CQ-147 is closed and accepted by Codex/governor. Analytics tools/errors now
  tuple-match result rows by `tool_call_id/session_id/store_id/receipt_id`,
  route-level analytics auth/input tests exist, and the v2/local analytics
  contract narrowing is pinned.
- CQ-148 is open and blocks L6.4/final Lane 6 acceptance: `tool-calls/list`
  can still attach a current-authority `projection_tool_result` row from the
  wrong call tuple. Its LATERAL result join gates result rows by current
  authority, but only matches `r.tool_call_id = c.tool_call_id`; it must also
  match `r.session_id = c.session_id`, `r.store_id = c.store_id`, and
  `r.receipt_id = c.receipt_id`. Add handler tests proving wrong-session,
  wrong-receipt, and wrong-store result rows are ignored, including under
  `errorsOnly`.
- CQ-141 is closed and accepted. Do not keep iterating on CQ-141 unless a fresh
  focused smoke command proves a new regression.
- CQ-124 remains open for Lane 10: the full v1/v2 table-name cutover is not
  Lane 6 scope. Do not rename or namespace the whole v2 schema unless you first
  prove a direct Lane 6 blocker with a smoke command and ask Codex/governor for
  a binary decision. Safe default: do not start Lane 10 cutover.
- CQ-134 object-pack byte coverage is closed for Lane 5 through CQ-141. The
  projection/search materialization sub-bullets remain blocked on CQ-124 and
  Lane 10. Lane 6 reads may expose only rows that already exist and pass the
  verified-authority gate; do not fake materialized rows.

Existing `apps/api/src/trpc/routers/reads/*` code is not accepted as Lane 6 by
itself. Inventory it, adapt or replace it as needed, and prove the Lane 6
contract with the tests below.

## Lane 6 invariants

- Reads are remote-authoritative: the server returns only data already promoted
  to and verified by the server.
- Every read is tenant scoped. Never trust a client-supplied tenant/store id
  without auth-context membership.
- Every projection/search read is receipt pinned. Rows without current
  `remote_authority_v2` coverage for the tenant/store are invisible.
- Every paginated cursor must also be receipt-snapshot pinned. Page 2 must use
  the same `(store_id, receipt_id)` authority set as page 1 even if a new
  promotion lands between requests.
- Authority refresh returns only the caller's store authority and uses a 30 s
  in-process cache without bypassing tenant scope.
- Cursors are opaque base64url JSON over stable sort tuples plus the authority
  snapshot, not offsets. Snapshot cursors must be integrity protected; never
  trust a client-provided `(store_id, receipt_id)` tuple unless the server can
  prove it issued that cursor.
- Search uses Postgres FTS and preserves filters for role, tool name,
  canonical tool type, errors-only, session, and time bounds.
- Artifact reads verify projection authority and object/pack grants before
  returning bytes. Large or binary content must be bounded/fail closed.
- Query-time cross-store aggregation returns one row per logical session with
  deterministic conflict resolution.

## Implementation order

Work in committed slices with focused evidence:

1. Authority refresh endpoint and cache TTL tests.
2. Shared verified-projection/authority helper plus fail-closed integration
   tests.
3. Sessions list/count/detail with stable filters and cursors.
4. Sessions transcript pagination with bounded inline text.
5. Search query with FTS, snippets, filters, and cursors.
6. Tool-calls list and artifacts.getText.
7. Analytics summary/report and cross-store distinct aggregation.
8. Performance/cache smoke evidence and final gate cleanup.

## Required tests

Create or update the Lane 6 tests under `apps/api/test/v2/reads/`:

- `authority-refresh.test.ts`
- `verified-projection-gate.test.ts`
- `sessions-list.test.ts`
- `search-fts.test.ts`
- `transcript-pagination.test.ts`
- `artifacts-get-text.test.ts`
- `analytics-report.test.ts`
- `cross-store-distinct.test.ts`
- lint/integration coverage proving no read path bypasses the shared gate.

## Blocker verification

Any blocker claim about Docker, Postgres, object storage, native dependencies,
package-manager policy, missing projection rows, FTS support, or schema
conflicts must include a direct smoke command and exact output before rerouting.

If the blocker is architectural, ask one explicit binary question with a safe
default. Do not spin on vague external acceptance.

## Gates

Lane 6 is not accepted until these are green and recorded in
`docs/roadmap/rearch-2/evidence/lane-06.md`:

```text
pnpm --filter @c3-oss/prosa-api test
pnpm typecheck
pnpm lint
git diff --check
```

Required Lane 6 evidence:

- Authority refresh returns `unchanged | updated | gone_or_forbidden` and the
  30 s cache produces one Postgres query per `(tenant, store)` per TTL window.
- Verified-projection gate enforced: a projection/search row without current
  authority is invisible.
- Sessions list/count/detail/transcript are tenant scoped, cursor-stable, and
  receipt pinned.
- Search query supports the required filters and snippets via Postgres FTS.
- Tool-calls list and artifacts.getText enforce verified projection plus
  receipt/object grants.
- Artifacts route tests prove the same opaque fail-closed shape as the handler;
  a route-level 500 for a missing artifact is not accepted.
- Analytics summary/report return the fixed contract shapes.
- Cross-store conflict resolution returns one row per logical session.
- p95 latency evidence under fixture load:
  - sessions/list < 200 ms
  - search/query < 200 ms
  - sessions/transcript first page < 500 ms for a typical session
  - artifacts/getText for 1 MiB < 1 s

## Completion rule

Do not output `RALPH_DONE` unless all Lane 6 gates/evidence/CQs are clean. The
five-cycle stabilization lane is optional when no useful Ralph work remains:
if the final code/tests/docs are clean and Codex/governor has no remaining
blocker, stop for governor acceptance instead of spending cycles on empty
stabilization. If Codex/governor explicitly requests stabilization, document
the requested cycles before `RALPH_DONE`. If Lane 6 reaches its gate, stop for
Codex/governor acceptance before starting Lane 7.
