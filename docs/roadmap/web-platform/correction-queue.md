# Web Platform Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

### CQ-001: Browser E2E must prove the required console product flow

Severity: critical
Blocking: yes
Status: open
Owner: Ralph

Problem:
Lane 08 browser E2E is marketing-only. It does not cover signup, login,
console, sessions, session detail, search, analytics, artifact authorization,
and logout. The deployment doc also says the real signup-to-logout flow is a
future/manual milestone.

Risk:
`RALPH_DONE` could be declared without proving the browser product actually
works against authenticated API-backed console flows.

Required fix:
- Add an isolated browser E2E flow that covers signup, login, empty console,
  seeded or promoted session data, session detail, search, analytics, artifact
  authorization, and logout.
- Provide a reproducible API/database/object-store harness or seed/promote path
  for the browser E2E.
- Update `docs/roadmap/web-platform/gates.md` with the exact browser E2E command
  and prerequisites.
- Update `docs/roadmap/web-platform/evidence/lane-08.md` with command output.

Acceptance:
- [ ] `pnpm --filter @c3-oss/prosa-web e2e` or the documented browser E2E command
  passes from a clean checkout with documented prerequisites.
- [ ] The E2E includes authenticated console routes, not only marketing routes.
- [ ] The E2E proves at least one promoted/seeded session can be listed, opened,
  searched, and included in analytics.
- [ ] Gates and lane 08 evidence record the exact command and result.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-e2e-gate-runner` finding, 2026-05-15.
  Verification after `d5363be`: FAIL. Authenticated E2E covers only empty
  console routes and logout; it lacks real login, seeded/promoted session rows,
  session detail, search result tied to data, analytics count assertion, artifact
  route/authorization, and exact gate/evidence documentation. Alternate-port
  Playwright run passed 3 tests, but default port was occupied and coverage is
  insufficient.

### CQ-002: Public marketing routes must not require or probe the API

Severity: high
Blocking: yes
Status: open
Owner: Ralph

Problem:
Current Playwright evidence observed `/trpc/auth.me` on `/`. `App.tsx` wraps all
routes in `AppProviders`; `AuthProvider` unconditionally queries `auth.me`.
Public routes are required to render without API availability and without API
calls.

Risk:
The public site can regress performance, privacy, and uptime by coupling
marketing pages to the API/auth server.

Required fix:
- Ensure public/marketing routes do not call `auth.me`, `/trpc/*`, or
  `/api/auth/*` during initial render.
- Scope auth/session hydration to auth or console route groups, or otherwise
  lazily enable it only where required.
- Add browser or component tests that fail on unexpected public-route API calls.

Acceptance:
- [ ] Landing page E2E fails if `/trpc/*` or `/api/auth/*` is requested.
- [ ] Landing and public routes render when API is unreachable.
- [ ] Console routes still hydrate auth/session and fail closed when unauthenticated.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-e2e-gate-runner` finding, 2026-05-15.
  Verification after `d5363be`: FAIL. Landing E2E aborts `/trpc/*` and
  `/api/auth/*` requests rather than failing on them. Public routes still mount
  `AuthProvider`, which calls `auth.me` on app boot.

### CQ-003: Artifact/object reads must require verified promoted object provenance

Severity: critical
Blocking: yes
Status: open
Owner: Ralph

Problem:
`artifacts.getText` authorizes raw `objectId` reads using `tenant_object`, which
can exist after `commitUpload` and before `verifyPromotion`. `/objects/:objectId`
has the same committed-but-unverified exposure. The `artifactId` path proves a
verified owning session but not verified object provenance, and can join
`projection_artifact` to global `remote_object` without proving a tenant object
grant.

Risk:
Committed-but-unverified object bytes can be read through the console/API before
promotion verification completes.

Required fix:
- Require both tenant ownership and verified promotion provenance for HTTP
  object reads and artifact text reads.
- Prove the object was declared and verified by the relevant promotion manifest
  before touching object storage.
- Require artifact rows to prove verified session data and verified tenant object
  ownership.
- Fail closed for unverified or unsupported object provenance.

Acceptance:
- [ ] Test denies `artifacts.getText` for a committed but unverified
  `tenant_object`.
- [ ] Test denies `/objects/:objectId` GET for a committed but unverified
  `tenant_object`.
- [ ] Test denies an artifact row pointing at an ungranted object.
- [ ] Test denies artifact reads when the owning session is verified but the
  referenced object is not verified.
- [ ] Test allows artifact/object text only when tenant ownership and verified
  object provenance are both present.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-remote-read-reviewer` and
  `ralph-loop-security-reviewer` findings, 2026-05-15.

### CQ-004: Read API auxiliary rows must be verified or fail closed

Severity: high
Blocking: yes
Status: open
Owner: Ralph

Problem:
`sessions.detail`, `toolCalls.list`, and `analytics.report` gate the owning
session but expose auxiliary rows such as events, artifacts, tool calls,
messages, and analytics joins without independently proving verified provenance
for those rows.

Risk:
Unverified or directly seeded remote projection rows can appear in console/API
responses after promotion.

Required fix:
- Add verified-data gating for every row type exposed by session detail,
  tool-call list, and analytics reports.
- If a row type lacks verified manifest provenance, omit it or return a clear
  unsupported/unverified response rather than exposing it.

Acceptance:
- [ ] Tests prove unverified events/artifacts are omitted or rejected in
  `sessions.detail`.
- [ ] Tests prove unverified tool rows are omitted or rejected in
  `toolCalls.list`.
- [ ] Tests prove analytics does not count unverified projection rows.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-remote-read-reviewer` finding, 2026-05-15.
  Verification after `d5363be`: FAIL. Auxiliary rows still lack verified
  manifest provenance; current tests seed auxiliary rows directly after
  verifying only sessions/search docs and expect them to be visible.
  Security verification after `d5363be`: FAIL. Raw `GET /objects/:objectId`
  still authorizes on `remote_object` + `tenant_object` only and streams bytes
  without verified object manifest provenance.

### CQ-005: Search and tool-call pagination/filters must be truthful

Severity: high
Blocking: yes
Status: open
Owner: Ralph

Problem:
`toolCalls.list` cursor pagination serializes timestamps as ISO but compares
against Postgres `timestamptz::text`, which can duplicate or skip rows. Also,
`search.query` accepts filters such as roles, tool names, canonical tool types,
errors-only, and mode but does not enforce them, compares documented field kinds
against stored composite `kind` values, and uses `ILIKE` instead of remote
Postgres FTS semantics. `toolCalls.list` also accepts canonical tool type and
path filters but does not enforce them.

Risk:
Audit/search users can receive incomplete, duplicated, or misleading results
while believing filters were applied.

Required fix:
- Make `toolCalls.list` cursor pagination deterministic with matching cursor
  serialization/comparison and `id` tie-breaker.
- Implement every accepted search filter exactly, or reject unsupported filters.
- Implement every accepted tool-call filter exactly, including canonical tool
  type and path substring, or reject unsupported filters.
- Replace `ILIKE` search with documented Postgres FTS behavior, or explicitly
  block `RALPH_DONE` until v0 FTS is implemented.

Acceptance:
- [ ] Tests cover page 1/page 2 `toolCalls.list` pagination with equal
  timestamps and no duplicate/skip behavior.
- [ ] Tests prove each accepted search filter is enforced.
- [ ] Tests prove each accepted tool-call filter is enforced.
- [ ] Tests prove documented `fieldKinds` map correctly to remote stored search
  kinds.
- [ ] Tests prove unsupported search modes/filters fail closed rather than
  being ignored.
- [ ] Search implementation matches the remote Postgres FTS requirement.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-remote-read-reviewer` and
  `prosa-cli-search-specialist` findings, 2026-05-15.
  Verification after `d5363be`: FAIL. Search still uses `ILIKE`, `rank` is
  `NULL`, snippets are substring-based, ordering is timestamp/id rather than FTS
  rank, and field-kind mapping from local semantics to remote stored kind remains
  unproven. Search/export verifier also failed CQ-005: no Postgres FTS,
  `fieldKinds` compare directly to composite remote `kind`, and tests do not
  prove FTS semantics, supported metadata filters, field-kind mapping, or
  equal-timestamp tool pagination.

### CQ-006: Remote analytics and CLI sessions must preserve parity contracts

Severity: high
Blocking: yes
Status: open
Owner: Ralph

Problem:
Remote analytics rebuilds simplified SQL with different columns, missing
filters, and snake_case rows instead of matching existing analytics semantics.
Remote CLI `sessions` output also drops columns and changes JSON shape by adding
`meta` where local JSON is a bare array.

Risk:
Promoted stores produce different analytics and CLI output than local stores,
breaking scripts and making the web "same analytics semantics" claim false.

Required fix:
- Align `analytics.report` columns, filters, and camelCase output with the five
  existing analytics report semantics or document and fail closed for unsupported
  parity.
- Preserve CLI remote `sessions` table/JSON output parity with local commands,
  or explicitly gate unsupported differences behind documented options.

Acceptance:
- [ ] Tests cover remote analytics report columns and filters for all five
  reports.
- [ ] Tests prove analytics response keys are camelCase for web API consumers.
- [ ] Tests cover remote CLI `sessions` JSON/table parity with local output.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-remote-read-reviewer` and
  `prosa-cli-search-specialist` findings, 2026-05-15.
  Verification after `d5363be`: FAIL. Remote analytics only accepts generic
  filters, report columns remain simplified, and CLI remote sessions still
  changes JSON shape through metadata wrapping. Search/export verifier also
  failed CQ-006: all five remote reports remain simplified and remote CLI
  sessions JSON/table parity remains broken.

### CQ-007: Browser signup must not return bearer tokens to JavaScript

Severity: high
Blocking: yes
Status: open
Owner: Ralph

Problem:
Browser signup returns a bearer/session token to frontend JavaScript even though
the browser auth model is intended to use HTTP-only cookies.

Risk:
Any XSS, compromised dependency, or captured API response can reuse the token as
`Authorization: Bearer ...` against tRPC or object routes, bypassing the cookie
boundary.

Required fix:
- Split browser signup/login behavior from CLI token-returning auth behavior.
- Browser signup must set only HTTP-only cookies and return no bearer/session
  token to JavaScript.
- Keep token-returning auth CLI-only or reject browser `Origin` callers for
  token responses.

Acceptance:
- [ ] API test asserts browser signup responses do not contain `token`.
- [ ] Web signup/login flows still authenticate via cookie session.
- [ ] CLI/device token flows continue to work where intentionally supported.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-security-reviewer` finding, 2026-05-15.
  Verification after `d5363be`: FAIL. Browser login and direct Better Auth
  signup still expose token-bearing JSON to browser JavaScript; only the tRPC
  tenant signup path omits token for configured web origins.

### CQ-008: Object routes must not expose raw storage keys

Severity: medium
Blocking: yes
Status: open
Owner: Ralph

Problem:
Successful object upload responses include `storageKey`, leaking internal
object-store layout into clients and logs.

Risk:
The API violates the object reference contract and makes future bucket policy or
signed URL mistakes easier to exploit.

Required fix:
- Remove `storageKey` from object upload responses and any public API response.
- Return only public identifiers and status such as `objectId` and
  `alreadyExisted`.

Acceptance:
- [ ] Object route tests assert `storageKey` is absent from upload responses.
- [ ] No web/API response exposes raw object-store keys.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-security-reviewer` finding, 2026-05-15.
  Verification after `d5363be`: PARTIAL PASS. Code no longer appears to expose
  `storageKey`, but tests are still inadequate; replace source-regex assertions
  with real successful PUT/GET assertions that response bodies/headers omit
  storage keys before closing.

### CQ-009: Artifact preview must cap decoded bytes before full decompression

Severity: medium
Blocking: yes
Status: open
Owner: Ralph

Problem:
Artifact preview reads and decompresses the full object before applying
`maxBytes`.

Risk:
A tenant member can request a tiny preview of a large promoted artifact while
the server still loads and decompresses the full object, causing avoidable
memory and CPU pressure.

Required fix:
- Stream previews with a hard decoded-byte cap, or reject previews when catalog
  sizes exceed the preview limit.
- Ensure the implementation does not fully decompress large artifacts just to
  return a bounded preview.

Acceptance:
- [ ] Test proves artifact preview stops at `maxBytes + 1` or rejects oversized
  previews before full decompression.
- [ ] Response still reports truncation and metadata correctly.

Evidence:
- Commit:
- Tests:
- Notes: `ralph-loop-security-reviewer` finding, 2026-05-15.
  Verification after `d5363be`: PARTIAL PASS. Code uses bounded reads, but tests
  only validate `maxBytes` input on a missing artifact. Add a real large
  raw/zstd artifact preview test before closing.

### CQ-010: Lane 07 web/API tests must cover search, analytics, tools, and artifacts

Severity: medium
Blocking: yes
Status: open
Owner: Ralph

Problem:
Lane 07 gates require web search/tool/analytics/artifact tests and API semantic
tests, but current coverage misses the route behavior and the cases that would
catch ignored filters, FTS absence, analytics parity drift, tool-call
path/canonical filters, verified object access, and artifact truncation.

Risk:
The web console can pass happy-path tests while core audit/search/artifact
contracts remain broken.

Required fix:
- Add web route/component tests for `/console/search`, `/console/tool-calls`,
  `/console/analytics`, and artifact preview behavior.
- Add API tests for ignored/unsupported filters, Postgres FTS semantics,
  analytics parity, tool-call path/canonical filters, verified object access,
  and truncation/decompression limits.

Acceptance:
- [ ] Web tests cover all lane 07 routes and key empty/loading/error/data states.
- [ ] API tests fail before the CQ-003/CQ-005/CQ-006/CQ-009 fixes and pass after.
- [ ] Lane 07 and lane 08 evidence record the focused commands and results.

Evidence:
- Commit:
- Tests:
- Notes: `prosa-cli-search-specialist` finding, 2026-05-15.
  Verification after `d5363be`: FAIL. Focused API/web tests pass, but they do
  not cover Postgres FTS, field-kind mapping, supported metadata filters,
  equal-timestamp tool pagination, analytics parity against core report columns,
  or artifact preview route behavior.

## Closed

Move closed corrections here with commit and test evidence.

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
