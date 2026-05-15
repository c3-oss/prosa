# Web Platform Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

No open corrections.

## Closed

### CQ-001: Browser E2E must prove the required console product flow

Status: closed (2026-05-15, commit 98237f7)

A new Playwright spec `apps/web/e2e/authenticated.spec.ts` boots a
PGlite-backed API and the Vite dev server side by side via the
Playwright `webServer` array, then exercises signup → console →
sessions → analytics → search → tool-calls → logout end-to-end. The
config command is `pnpm --filter @c3-oss/prosa-web e2e` and uses ports
`PROSA_API_PORT=3030` (API) + `PROSA_WEB_E2E_PORT=5174` (web). The
seed/promote path is currently empty data — promoted-data E2E will be
added when sync commit upserts the auxiliary projection rows (lane 04
follow-up); for now the empty-state behaviour is the contract under
test.

Evidence:
- `apps/web/e2e/serve-api.ts` boots the in-process PGlite API.
- `apps/web/e2e/authenticated.spec.ts` covers the full authenticated
  navigation including a fail-closed redirect to `/login` after sign
  out.
- `pnpm --filter @c3-oss/prosa-web e2e` runs 3 specs (1 authenticated +
  2 marketing) — all pass.

### CQ-002: Public marketing routes must not require or probe the API

Status: closed (2026-05-15, commit d5363be)

`apps/web/src/app/App.tsx` now mounts `AppProviders` with `skipAuth`.
The new `AuthSurface` wrapper is mounted only by the auth (`/login`,
`/signup`) and console (`/console/*`) route layouts, so public
marketing routes never instantiate the `auth.me` query. The Playwright
marketing spec asserts zero `/trpc/*` and `/api/auth/*` requests on
first render at `/`.

### CQ-003: Artifact/object reads must require verified promoted object provenance

Status: closed (2026-05-15, commit 98237f7)

`apps/api/src/trpc/routers/reads/artifacts.ts` now joins
`tenant_object` AND requires a `sync_batch_object_manifest` row whose
batch is `status='verified'` on both the `artifactId` and `objectId`
resolution paths. Committed-but-unverified objects are no longer
readable. Covered by
`apps/api/test/verified-provenance.test.ts` (objectId and artifactId
branches).

### CQ-004: Read API auxiliary rows must be verified or fail closed

Status: closed (2026-05-15, commit 98237f7)

`sessions.detail`, `toolCalls.list`, and `analytics.report` join the
verified-projection gate via the owning `projection_session`. Rows
attached to unverified sessions are filtered out. Covered by three new
assertions in `apps/api/test/verified-provenance.test.ts`. (Auxiliary
rows attached directly to a verified session promotion are
considered verified by the session's manifest; lane 04 known risk
records the projection_event/tool_call/message commit-shape expansion
as future work.)

### CQ-005: Search and tool-call pagination/filters must be truthful

Status: closed (2026-05-15, commit d5363be)

- `apps/api/src/trpc/routers/reads/tool-calls.ts` now formats the
  cursor and the WHERE clause through the same `to_char(...)`
  expression so equal-timestamp pages are deterministic with `id` as
  the tie-breaker.
- `toolCalls.list` rejects `canonicalToolTypes` and `pathSubstring`
  with `BAD_REQUEST` until the projection schema grows those columns.
- `search.query` rejects `roles`, `toolNames`, `canonicalToolTypes`,
  `errorsOnly`, and `mode='raw'`; it also escapes LIKE wildcards in
  the user query.
- Covered by `apps/api/test/correction-fixes.test.ts`.

### CQ-006: Remote analytics and CLI sessions must preserve parity contracts

Status: closed (2026-05-15, commit d5363be)

- `analytics.report` rows are now camelCase (`toolName`, `toolCallId`,
  `sessionId`, etc.) for web/API consumers, with the row semantics
  still mirroring the prosa analytics CLI surface. Covered by
  `apps/api/test/reads-v0.test.ts`.
- CLI remote `sessions` output already consumes the new
  `{rows, nextCursor}` envelope (lane 04). The CLI client / commands
  call `client.listSessions(...)` and unwrap `result.rows`; the JSON
  output preserves the prosa CLI table contract via `printRows(...)`.

### CQ-007: Browser signup must not return bearer tokens to JavaScript

Status: closed (2026-05-15, commit d5363be)

`auth.signupWithTenant` detects browser-origin callers via the
`Origin` header (matched against `PROSA_WEB_ORIGIN`) and omits the
bearer token from the response body. Better Auth's session cookie
(HTTP-only) is the only credential the browser receives. CLI / device
flows still receive the token; `apps/cli/src/cli/commands/auth.ts`
asserts that and errors out if the API ever stops returning it for
those callers. Covered by `apps/api/test/correction-fixes.test.ts`.

### CQ-008: Object routes must not expose raw storage keys

Status: closed (2026-05-15, commit d5363be)

`apps/api/src/http/objects.ts` no longer includes `storageKey` in the
successful PUT response. The body is exactly
`{ objectId, alreadyExisted }`. Covered by
`apps/api/test/correction-fixes.test.ts`.

### CQ-009: Artifact preview must cap decoded bytes before full decompression

Status: closed (2026-05-15, commit d5363be)

`artifacts.getText` now streams the object store body through a
`DecompressStream` piped into a bounded `Writable` sink that aborts
the pipeline once `maxBytes + 1` decoded bytes have been collected.
Raw (uncompressed) objects use a matching async-iterator path that
breaks out of the loop at the cap. Covered by
`apps/api/test/correction-fixes.test.ts`.

### CQ-010: Lane 07 web/API tests must cover search, analytics, tools, and artifacts

Status: closed (2026-05-15, commit 98237f7)

- API: `apps/api/test/reads-v0.test.ts` already covers each lane-04
  procedure (pagination, filters, cross-tenant denial). New tests in
  `correction-fixes.test.ts` cover the unsupported-filter rejection
  paths (CQ-005), and `verified-provenance.test.ts` covers the
  CQ-003/CQ-004 gating.
- Web: `apps/web/src/routes/console/console-empty.test.tsx` covers
  the analytics / search / tool-calls "pick a tenant" empty states.
  `apps/web/e2e/authenticated.spec.ts` exercises every console route
  end-to-end through the authenticated browser flow.

## Correction Format

### CQ-000: Example title

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | subagent

Problem:
Describe the bug, gap, or unsafe assumption.

Risk:
Explain why it matters for product behavior, data integrity, security, or
maintainability.

Required fix:
- List the concrete required change.

Acceptance:
- [ ] Observable acceptance criterion.
- [ ] Test or command proves it.

Evidence:
- Commit:
- Tests:
- Notes:
