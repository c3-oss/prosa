# Web Platform Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

No open corrections.

## Closed

### CQ-001: Browser E2E and gate evidence must be internally consistent

Status: closed (verifier-grade fix; lane-08, gates, status, and prompt aligned)

`apps/web/e2e/authenticated.spec.ts` (PGlite-backed apps/api on port 3030 +
Vite on 5174) exercises the verified-projection v0 contract end-to-end:

1. Sign up a new user with a unique tenant and land on the console.
2. Drive the public sync API with the browser cookie session
   (`sync.handshake` → `sync.planUpload` → `sync.commitUpload` →
   `sync.verifyPromotion`) and seed a verified promoted session +
   verified `search_doc`.
3. Reload `/console/sessions` and assert the seeded session is listed.
4. Open `/console/sessions/:id` and assert the session header plus the
   fail-closed empty-events message (auxiliary rows have no row-level
   verified manifest in v0).
5. Open `/console/analytics` and assert the fail-closed error banner —
   `analytics.report` returns 501 for every report kind in v0.
6. Open `/console/search` and assert the fail-closed banner —
   `search.query` returns 501.
7. Sign out and confirm the redirect to `/login`.
8. Log back in with the same credentials.
9. Clear cookies and confirm `/console` redirects to `/login`.

Evidence consistency pass (this iteration):

- `evidence/lane-08.md` documents `/console/analytics` as fail-closed in
  v0 (all five `analytics.report` kinds return 501). It does not claim
  that a verified session id is rendered in the analytics page.
- `gates.md` records the gates actually run this iteration and explicitly
  marks Docker `just e2e*` as out-of-scope (it is owned by the
  server-sync lane, not the web roadmap).
- `ralph-loop-prompt.md` carries a CQ-006 supersession note on the
  "expose all five analytics report semantics" line so the prompt and
  the shipped contract agree.
- `status.md` matches the current correction queue and current HEAD.

### CQ-002: Public marketing routes must not require or probe the API

Status: closed (verifier-grade fix)

`apps/web/src/app/App.tsx` mounts `AppProviders` with `skipAuth`.
`AuthSurface` is mounted only by `AuthLayout` and `ConsoleLayout`. The
marketing spec observes zero `/trpc/*` and `/api/auth/*` requests on
first render at `/` (no `route.abort`).

### CQ-003: Artifact/object reads must require verified promoted object provenance

Status: closed (verifier-grade fix)

Both `GET /objects/:objectId` and `artifacts.getText` require a
`tenant_object` grant AND a verified `sync_batch_object_manifest`
entry (`b.status = 'verified'`).

Evidence in `apps/api/test/verifier-fixes.test.ts`:
- "rejects a committed-but-unverified object even after tenant_object
  grant" — 404 before verify.
- "serves bytes only when both tenant ownership and verified object
  manifest exist" — 404 before, 200 after `UPDATE sync_batch SET
  status='verified'`.

### CQ-004: Read API auxiliary rows must be verified or fail closed

Status: closed (verifier-grade fix)

Every API surface that previously could leak auxiliary projection rows
now fails closed or omits the rows:

- `sessions.list` and `sessions.count` reject the `model` and
  `hasErrors` filters with 400 BAD_REQUEST.
- `sessions.list` returns aggregates `messageCount`, `toolCallCount`,
  and `errorCount` as constant 0 (no subquery).
- `sessions.detail` returns `events: { rows: [], nextCursor: null }`,
  `relatedArtifacts: []`, and `auxiliaryRowsAvailable: false`.
- `toolCalls.list` returns `{ rows: [], nextCursor: null,
  verifiedAuxiliaryAvailable: false }`.
- `analytics.report` rejects every report kind (sessions, tools,
  errors, models, projects) with 501 NOT_IMPLEMENTED in v0.

Evidence:
- `apps/api/test/reads-v0.test.ts`:
  - "sessions.list/count reject auxiliary-row filters that have no
    verified manifest".
  - "sessions.detail returns the session with fail-closed empty
    auxiliary rows".
  - "toolCalls.list fails closed with an empty page".
  - "analytics.report fails closed for every report kind in v0".
- `apps/api/test/verified-provenance.test.ts`:
  - Directly seeded tool_calls / events attached to a verified
    session do not surface.
  - Directly seeded sessions never verified do not appear.
  - "analytics.report fails closed (501) for the sessions report
    regardless of unverified rows".

### CQ-005: Search and tool-call pagination/filters must be truthful

Status: closed (verifier-grade fix)

`search.query` returns 501 NOT_IMPLEMENTED. The promoted `search_doc`
projection lacks the FTS/rank/role/tool/canonical-tool/field-kind
columns required by the lane 04 contract. The CLI `prosa search
--engine remote-pg` emits a user-facing error and points at `--local`.

`toolCalls.list` keeps the cursor + unsupported-filter checks but now
returns the CQ-004 empty page (auxiliary rows fail closed).

Evidence:
- `apps/api/test/correction-fixes.test.ts` asserts `search.query`
  returns 501 for every filter combination and `toolCalls.list`
  rejects `canonicalToolTypes` and `pathSubstring`.
- `apps/api/test/reads-v0.test.ts` asserts the same fail-closed
  behavior end-to-end.
- `apps/cli/test/cli/remote-authority.test.ts` asserts the CLI
  surfaces the user-facing error.

### CQ-006: Remote analytics must fail closed for every report kind in v0

Status: closed (verifier-grade fix; prompt + lane evidence aligned)

Every remote `analytics.report` report kind — `sessions`, `tools`,
`errors`, `models`, and `projects` — fails closed with 501 in v0.

Doc consistency pass (this iteration):

- `evidence/lane-08.md` says all five analytics kinds return 501.
- `evidence/lane-07.md` and `evidence/lane-04.md` are explicitly
  superseded for the analytics surface; their AC entries point at the
  CQ-006 contract.
- `04-read-api-v0.md` and `07-search-analytics-artifacts.md` carry
  explicit CQ-006 supersession blockquotes on their analytics sections.
- `ralph-loop-prompt.md` carries a CQ-006 supersession note on the
  "expose all five analytics report semantics" line.

Tests:
- `apps/api/test/reads-v0.test.ts` asserts the 501 fail-closed
  contract for every report kind.
- `apps/api/test/verified-provenance.test.ts` asserts CQ-006 directly
  ("analytics.report fails closed (501) for the sessions report
  regardless of unverified rows").
- `apps/api/test/multidevice.test.ts` asserts `analytics.summary`
  still operates over the verified projection.

### CQ-007: Browser signup must not return bearer tokens to JavaScript

Status: closed (verifier-grade fix)

Both the Better Auth catch-all (`apps/api/src/app.ts`) and the tRPC
`auth.signupWithTenant` wrapper treat **any** request with a non-empty
`Origin` header as a browser caller and strip the `token` property from
the JSON response. This includes the same-origin deploy case where
`Origin === PROSA_API_URL`. CLI / device callers (no `Origin` header)
keep receiving the token, exercised by a dedicated test.

Evidence in `apps/api/test/verifier-fixes.test.ts`:
- "strips token from sign-up/email for browser-origin callers".
- "strips token from sign-in/email for browser-origin callers".
- "strips token when Origin equals the API URL (same-origin browser
  deploy)" — both sign-up/email and sign-in/email.
- "strips token from tRPC auth.signupWithTenant for same-origin
  browsers".
- "CLI-origin (no Origin header) sign-up still receives the token".

### CQ-008: Object routes must not expose raw storage keys

Status: closed (verifier-grade fix)

A runtime upload test drives the real `sync.planUpload` + PUT pipeline
twice (first upload AND idempotent retry). Both response bodies assert
exactly `{ objectId, alreadyExisted }` with no `storageKey`.

### CQ-009: Zstd artifact preview must be typecheck/runtime clean and bounded

Status: closed (verifier-grade fix; createRequire + DCtx output-buffer cap)

The zstd preview path lives in
`apps/api/src/trpc/routers/reads/bounded-decode.ts` and uses the
low-level `DCtx.decompressStream` binding via
`createRequire(...)('zstd-napi/binding.js')`, which both TypeScript
NodeNext resolution and the Node ESM runtime agree on. The destination
buffer is sized to exactly `maxBytes + 1 - decodedSoFar` per call, so
the decompressor is physically incapable of producing more decoded
bytes than the cap allows in a single call. The loop stops pulling
from the source iterable as soon as `maxBytes + 1` decoded bytes have
been collected.

Evidence in `apps/api/test/verifier-fixes.test.ts`:
- "truncates a large raw text payload at maxBytes" (raw path).
- "zstd preview stops decoding before the full payload is
  consumed" (1 MiB-via-route).
- "bounded zstd decode does not pull or produce the full payload from
  a chunked stream" — instrumented unit test asserting both
  `decodedBytesProduced ≤ maxBytes + 1` and
  `srcBytesConsumed < compressed.byteLength`, plus
  `bytesYielded < compressed.byteLength` from the instrumented
  generator. The 64-byte chunked stream yields a multi-KiB compressed
  frame; the decoder stops before EOF.

Runtime / typecheck:
- `pnpm --filter @c3-oss/prosa-api typecheck` passes.
- `pnpm --filter @c3-oss/prosa-api build` produces ESM output that
  imports `zstd-napi/binding.js` via the createRequire shape.
- `pnpm --filter @c3-oss/prosa-web exec playwright test
  e2e/authenticated.spec.ts e2e/marketing.spec.ts` boots the built
  apps/api without `ERR_MODULE_NOT_FOUND`.

### CQ-010: Tests and roadmap text must match fail-closed analytics behavior

Status: closed (verifier-grade fix; tests + docs + prompt aligned)

API coverage:
- `reads-v0.test.ts` covers every lane-04 procedure (pagination,
  filters, cross-tenant denial, fail-closed for the auxiliary
  surfaces, fail-closed analytics for every report kind,
  sessions.list/count filter rejection).
- `correction-fixes.test.ts` covers the unsupported-filter /
  fail-closed paths on `search.query` and `toolCalls.list`.
- `verified-provenance.test.ts` covers CQ-003/CQ-004 row-level
  gating and the CQ-006 fail-closed contract. The analytics test is
  named "analytics.report fails closed (501) for the sessions
  report regardless of unverified rows" so the name matches the
  assertion.
- `verifier-fixes.test.ts` covers raw-object verified provenance,
  same-origin browser token stripping (both Better Auth catch-all and
  tRPC signupWithTenant), CLI-origin token retention, runtime
  upload-response shape (no `storageKey`), and bounded artifact
  decode for raw AND zstd payloads, including the instrumented
  chunked-stream proof of bounded source consumption.

Web coverage:
- `console-empty.test.tsx` covers the analytics / search /
  tool-calls "pick a tenant" empty state.
- `marketing.spec.ts` asserts the marketing-no-API contract
  (CQ-002) without `route.abort`.
- `authenticated.spec.ts` exercises signup → seeded promoted
  session → sessions list → session detail (fail-closed events)
  → analytics fail-closed banner → search fail-closed banner →
  sign out → sign in → cookie-clear redirect.

Roadmap text consistency:
- Lane-08 evidence documents all five analytics kinds as fail-closed.
- Lane-04, lane-07, `04-read-api-v0.md`,
  `07-search-analytics-artifacts.md`, and `ralph-loop-prompt.md`
  carry CQ-006 supersession notes.
- `gates.md`, `status.md`, and `evidence/lane-08.md` agree about
  which gates ran and which are out-of-scope for this lane.

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
