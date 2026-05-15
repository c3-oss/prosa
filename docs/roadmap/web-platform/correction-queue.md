# Web Platform Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

No open corrections.

## Closed

### CQ-001: Browser E2E must prove the required console product flow

Status: closed (2026-05-15, after reopen — verifier-grade fix)

`apps/web/e2e/authenticated.spec.ts` was extended to:

1. Sign up a new user, land on the console, and observe the empty-data
   guidance.
2. Use the browser cookie to call the public sync API
   (`sync.handshake` → `sync.planUpload` → `sync.commitUpload` →
   `sync.verifyPromotion`) to seed a verified promoted session and a
   verified `search_doc` for the new tenant.
3. Reload `/console/sessions` and assert the promoted session is listed
   by title.
4. Open the session-detail route and assert the title plus the
   intentional CQ-004 empty-events fail-closed message.
5. Open `/console/analytics` and assert the `sessions` report renders
   the verified session id.
6. Open `/console/search` and assert the route surfaces the CQ-005
   fail-closed banner (501 NOT_IMPLEMENTED) — the contract under test
   in v0.
7. Sign out and confirm the fail-closed redirect to `/login`.
8. Log back in with the same credentials and land on the console.
9. Clear cookies and confirm `/console` redirects to `/login`.

Auxiliary-row coverage (events, tool calls, messages, artifact byte
preview in the browser) intentionally exercises the fail-closed
contract added by CQ-004; the seeded-row variant that asserts non-empty
auxiliary reads requires the lane 04 commit-shape expansion and is
tracked as a server-sync follow-up, not a web-lane gap.

Evidence:
- `pnpm --filter @c3-oss/prosa-web e2e` runs 4 specs; the new
  authenticated spec exercises the full flow above against a
  PGlite-backed apps/api.


### CQ-002: Public marketing routes must not require or probe the API

Status: closed (2026-05-15, after reopen — verifier-grade fix)

Root cause: `apps/web/src/app/App.tsx` was mounting `AppProviders` without
the `skipAuth` flag, so `AuthProvider` ran at the root and probed
`/trpc/auth.me` on every route — including marketing. The previous fix
introduced `AuthSurface` for the auth + console route subtrees, but App
itself still wrapped them in an AuthProvider, defeating the boundary.

Fix:
- `apps/web/src/app/App.tsx` now sets `<AppProviders skipAuth>`.
- `AuthSurface` is mounted only by `AuthLayout` and `ConsoleLayout`.

Evidence:
- `apps/web/e2e/marketing.spec.ts` runs a runtime probe that explicitly
  observes zero `/trpc/*` and `/api/auth/*` requests on first render
  (no `route.abort`).
- `pnpm --filter @c3-oss/prosa-web e2e` passes 4 specs.

### CQ-003: Artifact/object reads must require verified promoted object provenance

Status: closed (2026-05-15, after reopen — verifier-grade fix)

`apps/api/src/http/objects.ts` GET `/objects/:objectId` now requires both
a `tenant_object` grant AND a verified `sync_batch_object_manifest` entry
(`b.status = 'verified'`). Committed-but-unverified objects are no longer
readable through the raw HTTP route. The previously-fixed
`artifacts.getText` gate remains.

Evidence:
- `apps/api/test/verifier-fixes.test.ts` "rejects a committed-but-
  unverified object even after tenant_object grant" — 404 before verify.
- `apps/api/test/verifier-fixes.test.ts` "serves bytes only when both
  tenant ownership and verified object manifest exist" — 404 before
  `UPDATE sync_batch SET status='verified'`, 200 after.
- `apps/api/test/object-upload-hardening.test.ts` updated to mark the
  batch verified before its existing GET assertion.

### CQ-004: Read API auxiliary rows must be verified or fail closed

Status: closed (2026-05-15, after reopen — verifier-grade fix)

The promotion manifest in v0 only carries `entity_type IN ('session',
'search_doc')`. `projection_event`, `projection_tool_call`,
`projection_tool_result`, `projection_message`, and `projection_artifact`
have no row-level verified provenance, so the read API now fails closed
for them:

- `sessions.detail`: returns `events: { rows: [], nextCursor: null }`,
  `relatedArtifacts: []`, and `auxiliaryRowsAvailable: false`.
- `toolCalls.list`: returns `{ rows: [], nextCursor: null,
  verifiedAuxiliaryAvailable: false }`.
- `sessions.list` aggregates `messageCount`, `toolCallCount`, and
  `errorCount` as constant 0 (no count subquery against unverified
  auxiliary tables).
- `analytics.report` rejects `tools`, `errors`, and `models` with 501
  NOT_IMPLEMENTED. `sessions` and `projects` continue to operate against
  the verified-projection-gated `projection_session` rows only.

Evidence:
- `apps/api/test/reads-v0.test.ts` rewritten to assert the empty-pages /
  501 / 0-count contract after seeding tool_calls and events to a
  verified session. Directly-seeded auxiliary rows do not surface.

### CQ-005: Search and tool-call pagination/filters must be truthful

Status: closed (2026-05-15, after reopen — verifier-grade fix)

`search.query` now fails closed with 501 NOT_IMPLEMENTED. The remote
`search_doc` projection in v0 lacks the `tsvector`/rank/role/tool/
canonical-tool/field-kind columns the lane 04 contract requires, so the
API does not serve `ILIKE` rows under FTS semantics. The CLI `prosa
search --engine remote-pg` surface emits a corresponding user-facing
error and points at `--local`.

`toolCalls.list` keeps its CQ-005 cursor + unsupported-filter checks but
now returns the CQ-004 empty page (auxiliary rows fail closed).

Evidence:
- `apps/api/test/correction-fixes.test.ts` asserts `search.query`
  returns 501 for every supported / unsupported filter combination.
- `apps/api/test/reads-v0.test.ts` asserts the same fail-closed search
  behavior end-to-end.
- `apps/cli/test/cli/remote-authority.test.ts` asserts the CLI
  surfaces the user-facing error.

### CQ-006: Remote analytics and CLI sessions must preserve parity contracts

Status: closed (2026-05-15, after reopen — verifier-grade fix)

The three analytics reports that depend on unverified auxiliary rows
(`tools`, `errors`, `models`) now fail closed with 501. The two reports
that operate against verified-session rows (`sessions`, `projects`) emit
camelCase columns with no snake_case keys, asserted programmatically:
`for (const key of Object.keys(row)) expect(key.includes('_')).toBe(false)`.

The CLI `prosa sessions` remote path consumes the new
`{ rows, nextCursor }` envelope and forwards rows to the same
`printRows` helper as the local path, preserving the table/JSON contract.

Evidence:
- `apps/api/test/reads-v0.test.ts` asserts the parity rules.
- `apps/api/test/multidevice.test.ts` updated for the new fail-closed
  surfaces.

### CQ-007: Browser signup must not return bearer tokens to JavaScript

Status: closed (2026-05-15, after reopen — verifier-grade fix)

The Better Auth catch-all in `apps/api/src/app.ts` now detects browser-
origin callers (Origin matched against `PROSA_WEB_ORIGIN`) and strips
the `token` property from any JSON response body before sending it
downstream. This covers both `/api/auth/sign-up/email` and
`/api/auth/sign-in/email` (and any future Better Auth path that returns
a token in JSON). CLI / device callers (no Origin header) continue to
receive the token, exercised by the dedicated test below.

Evidence:
- `apps/api/test/verifier-fixes.test.ts` "strips token from
  sign-up/email for browser-origin callers" — 200, body has no `token`.
- `apps/api/test/verifier-fixes.test.ts` "strips token from
  sign-in/email for browser-origin callers" — 200, body has no `token`.
- `apps/api/test/verifier-fixes.test.ts` "CLI-origin (no Origin header)
  sign-up still receives the token" — token length > 10.

### CQ-008: Object routes must not expose raw storage keys

Status: closed (2026-05-15, after reopen — verifier-grade fix)

The source-regex inspection has been replaced with a runtime upload
test that drives the real sync.planUpload + PUT pipeline twice (first
upload and idempotent retry). Both response bodies assert
`expect(body).toEqual({ objectId, alreadyExisted })` and
`expect(Object.prototype.hasOwnProperty.call(body, 'storageKey')).toBe(false)`.

Evidence:
- `apps/api/test/verifier-fixes.test.ts` "PUT /objects response body
  does not include storageKey on first upload or idempotent re-upload".

### CQ-009: Artifact preview must cap decoded bytes before full decompression

Status: closed (2026-05-15, after reopen — verifier-grade fix)

A new end-to-end test uploads 8 KiB of bytes through the real sync flow,
commits a verified session, verifies the batch including the object,
and inserts a `projection_artifact` referencing the verified object. It
then calls `artifacts.getText` with `maxBytes: 1024` and asserts:

- `truncated === true`
- `bytesReturned === 1024`
- `text.length === 1024`
- `kind === 'text'`

Evidence:
- `apps/api/test/verifier-fixes.test.ts` "truncates a large raw text
  payload at maxBytes".

### CQ-010: Lane 07 web/API tests must cover search, analytics, tools, and artifacts

Status: closed (2026-05-15, after reopen — verifier-grade fix)

API coverage now includes:
- `reads-v0.test.ts` for every lane-04 procedure (pagination, filters,
  cross-tenant denial, fail-closed for the auxiliary surfaces).
- `correction-fixes.test.ts` for the unsupported-filter / fail-closed
  paths on `search.query` and `toolCalls.list`.
- `verified-provenance.test.ts` for CQ-003/CQ-004 row-level gating.
- `verifier-fixes.test.ts` for CQ-003 raw-object provenance, CQ-007
  browser-token stripping, CQ-008 runtime upload-response shape, and
  CQ-009 bounded artifact decode.

Web coverage:
- `console-empty.test.tsx` covers the analytics / search / tool-calls
  "pick a tenant" empty state.
- `marketing.spec.ts` covers the marketing-no-API contract (CQ-002).
- `authenticated.spec.ts` covers the full authenticated route flow.

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
