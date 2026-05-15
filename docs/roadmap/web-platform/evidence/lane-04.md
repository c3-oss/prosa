# Lane Evidence

Lane: 04 Read API v0
Status: complete
Owner: Ralph
Commit range: `86f10fa`

## Acceptance Criteria

- [x] AC-001 API tests cover pagination, filters, tenant isolation, and
  verified-data gating for the new procedures
  (`apps/api/test/reads-v0.test.ts`).
- [x] AC-002 `sessions.detail` powers the console timeline without parsing
  Markdown — it joins the session row with cursor-paginated ordered
  `projection_event` rows and a bounded related-artifacts list.
- [x] AC-003 `search.query` supports global and per-session search with
  metadata filters (session, source, projects, field kind, time range).
- [x] AC-004 `analytics.report` exposes all five existing analytics report
  types: `sessions`, `tools`, `errors`, `models`, `projects`. The lightweight
  `analytics.summary` is retained for the dashboard.
  - **Superseded by CQ-006**: in the shipped v0 contract every
    `analytics.report` kind fails closed with 501 because the promotion
    manifest does not yet carry verified entries for the auxiliary tables
    those views join (and `project` is not in the manifest at all). The
    authoritative shipped behaviour is documented in `evidence/lane-08.md`
    and `correction-queue.md` under CQ-006. `analytics.summary` continues
    to operate over the verified projection.
- [x] AC-005 `artifacts.getText` refuses cross-tenant and unverified objects
  and returns bounded text with a `truncated` flag and `kind: 'text' |
  'binary'` discriminator.
- [x] AC-006 Web response types are stable (cursor-paginated `{rows,
  nextCursor}` envelopes, camelCase fields) and consumed by both the CLI
  client and the upcoming web console.

## Implementation Notes

- `apps/api/src/trpc/routers/reads.ts` is now a thin barrel that re-exports
  `sessionsRouter`, `searchRouter`, `toolCallsRouter`, `artifactsRouter`,
  and `analyticsRouter` from sibling files under `routers/reads/`.
- `routers/reads/shared.ts` centralises the cursor helpers,
  `tenantVerifiedProjectionSql` (verified-batch gate), and shared filter
  zod schemas (`cursorPageInput`, `eventCursorPageInput`, `timeRangeFilter`,
  `sourceFilter`).
- `sessions.list` rows now include aggregate `messageCount`,
  `toolCallCount`, `errorCount`, and `durationMs` computed via correlated
  subqueries. The cursor encodes a normalised ISO 8601 `started_at` so it
  is stable regardless of how Postgres prints `timestamptz`.
- `sessions.detail` returns an ordered `events` cursor page (kind, ordinal,
  timestamp, payload) plus a bounded `relatedArtifacts` list and the
  session metadata.
- `search.query` runs `ILIKE` over `search_doc.body` joined with the
  verified projection_session, with cursor pagination ordered by
  `indexed_at DESC, id DESC`. Postgres FTS (`tsvector`/`tsquery`) is the
  planned upgrade once a deterministic FTS expression is confirmed across
  pg + pglite.
- `toolCalls.list` exposes global and per-session audit rows, joined with
  the session for `sourceKind`/`sessionTitle` and with
  `projection_tool_result` for `resultStatus`, `finishedAt`, and
  `durationMs`.
- `artifacts.getText` resolves by `artifactId` against `projection_artifact`
  + verified-manifest or by `objectId` against `tenant_object`, fetches via
  the configured object store, decompresses zstd in-memory, returns up to
  `maxBytes` of UTF-8 text with a `truncated` flag and a `kind`
  discriminator (`text` vs `binary`).
- `analytics.report` covers the five report kinds with deterministic SQL
  matching the existing `session_facts` / `tool_usage_facts` /
  `error_facts` / `model_usage` / `project_activity` semantics.
  (Superseded by CQ-006: the shipped v0 contract instead returns 501 for
  every report kind. See `evidence/lane-08.md` and `correction-queue.md`.)
- The CLI client and existing API tests were updated to consume the new
  `{rows, nextCursor}` envelopes (`apps/cli/src/cli/auth/client.ts`,
  `apps/cli/src/cli/commands/sessions.ts`,
  `apps/cli/src/cli/commands/search.ts`,
  `apps/api/test/multidevice.test.ts`, `cross-tenant.test.ts`,
  `sync-transaction.test.ts`, `apps/cli/test/cli/sync-e2e.test.ts`).

## Commands Run

```text
pnpm --filter @c3-oss/prosa-api typecheck             (ok)
pnpm --filter @c3-oss/prosa-api test                  (ok — 65 passed, 1 skipped; 6 new reads-v0 cases)
pnpm --filter @c3-oss/prosa-api build                 (ok — regenerated dist for web types)
pnpm --filter @c3-oss/prosa-api lint                  (ok)
pnpm --filter @c3-oss/prosa typecheck                 (ok — CLI updated to new {rows,nextCursor} shape)
pnpm --filter @c3-oss/prosa test                      (ok — 91 passed, 1 skipped)
pnpm --filter @c3-oss/prosa lint                      (ok)
pnpm --filter @c3-oss/prosa-web typecheck             (ok — web types align with new procedures)
```

## Data / Security Evidence

- Every reads procedure uses `tenantProcedure`, so the request must carry
  a verified `member` row for the tenant — header-supplied tenant ids are
  candidates only (`apps/api/src/trpc/context.ts`).
- Every read filter joins `sync_batch_projection_manifest` joined with a
  `status = 'verified'` `sync_batch` to keep unverified data invisible.
- `artifacts.getText` resolves via `projection_artifact` (artifact path)
  or `tenant_object` (raw object path) — both prove tenant ownership before
  the object store is touched. No raw storage keys are returned to clients.
- Cursor payloads carry only the sort tuple (timestamp + id or sequence +
  id) and are encoded as base64url JSON. They are pure pagination state,
  not credentials.

## Known Risks

- `projection_event` is the canonical timeline source, but it is currently
  populated only by future commit-shape expansion. Lane 04 covers the
  read side; expanding the sync commit to upsert tool calls / messages /
  events end-to-end is a separate, follow-up server-sync lane that should
  not block console UI work.
- Search v0 uses ILIKE, which is sufficient for the console v0 but does
  not rank results. Lane 07 may revisit ranking once Postgres FTS is
  enabled and validated against PGlite test runs.

## Reviewer Notes

- Codex review of lane 04: new procedures, response envelopes, and tests
  match `04-read-api-v0.md`. Lane 05 picks up the dashboard + sessions
  UI against `sessions.list`, `sessions.count`, and `analytics.summary`.
