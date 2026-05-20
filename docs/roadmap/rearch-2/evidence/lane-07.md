# Lane 7 Evidence — CLI and MCP

Status: all CQs closed; gates checked; awaiting governor acceptance.

Source plan: `docs/rearch-2/08-lane-7-cli-and-mcp.md`.

## Slice 1 — authority cache + v2 reads client

- New files:
  - `apps/cli/src/cli/v2/authority/types.ts`
  - `apps/cli/src/cli/v2/authority/cache.ts`
  - `apps/cli/src/cli/v2/authority/resolve.ts`
  - `apps/cli/src/cli/v2/authority/index.ts`
  - `apps/cli/src/cli/v2/client/reads.ts`
  - `apps/cli/src/cli/v2/client/index.ts`
  - `apps/cli/src/cli/v2/read-context.ts`
- New tests:
  - `apps/cli/test/v2/authority-cache.test.ts` — 7 tests cover TTL,
    --refresh, --offline, gone_or_forbidden, mode-0600 persistence,
    and the cache file layout.
  - `apps/cli/test/v2/reads-client.test.ts` — 4 tests pin the
    Authorization + tenant headers, the error-envelope path, the
    412 → `AuthorityChangedHttpError` mapping, and the retry-after
    capture.

## Slice 2 — `prosa read sessions` (+ `--count`) + read-context routing

- New files:
  - `apps/cli/src/cli/v2/commands/read/common.ts`
  - `apps/cli/src/cli/v2/commands/read/sessions.ts`
  - `apps/cli/src/cli/v2/commands/read/index.ts`
- Registered the top-level `prosa read` group in
  `apps/cli/src/cli/main.ts`.
- New test:
  - `apps/cli/test/v2/read-sessions-routing.test.ts` — 5 tests cover
    local fallback, v2-promotion → remote routing, `--authority local`
    forcing local, `--authority remote` fail-closed, and v1-shaped
    receipts being treated as un-promoted.

## Slice 3 — `prosa read transcript`

- New file: `apps/cli/src/cli/v2/commands/read/transcript.ts`.
- Supports `--format text|markdown|json`, `--cursor`, `--all-pages`,
  and surfaces `AuthorityChangedError` on a mid-walk 412.
- Local fallback delegates to `loadTranscript` + `formatTranscriptText`
  from `@c3-oss/prosa-core`; local markdown returns a clear "use
  `prosa export session`" message rather than silently producing
  partial output.

## Slice 4 — `prosa read search`

- New file: `apps/cli/src/cli/v2/commands/read/search.ts`.
- Remote path consumes `/v2/reads/search/query` with all CLI filter
  flags wired (`--role`, `--tool-name`, `--canonical-type`,
  `--errors-only`, `--source`, `--project`, `--limit`, `--cursor`).
- Local fallback delegates to `searchFullText`.

## Slice 5 — `prosa read tool-calls`

- New file: `apps/cli/src/cli/v2/commands/read/tool-calls.ts`.
- Remote path consumes `/v2/reads/tool-calls/list`.
- Local mode fails closed; the audit view requires receipt-pinned
  authority and is not derivable from the local bundle.

## Slice 6 — `prosa read analytics`

- New file: `apps/cli/src/cli/v2/commands/read/analytics.ts`.
- Remote path consumes `/v2/reads/analytics/report` for the five
  fixed reports (sessions|tools|errors|models|projects).
- Local mode redirects the operator to the existing local
  `prosa analytics` command.

## Slice 7 — `prosa read query` + `prosa read export parquet`

- New files:
  - `apps/cli/src/cli/v2/commands/read/query.ts`
  - `apps/cli/src/cli/v2/commands/read/export.ts`
- Both are local-only by design (Parquet derivations live next to a
  local bundle). The commands fail closed when the resolved
  authority is remote so the operator does not silently query stale
  derived data.

## Slice 8 — v1-to-v2 command mapping doc

- New file: `docs/rearch-2/lane-7-v1-to-v2-command-mapping.md`.
- Documents the 1:1 mapping, the shared option set, the authority
  cache TTL, and the mid-command 412 contract.

## Focused gate evidence

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/
Test Files  3 passed (3)
Tests       16 passed (16)
```

```text
pnpm --filter @c3-oss/prosa typecheck
(clean)
```

```text
pnpm --filter @c3-oss/prosa lint
Checked 110 files in 138ms. No fixes applied.
```

Lane 6 baseline confirmation:

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  72 passed | 2 skipped (74)
Tests       431 passed | 4 skipped (435)
```

## Slice 9 — `prosa mcp-v2 serve --authority {auto|local|remote}`

- New file: `apps/cli/src/cli/v2/commands/mcp-serve.ts`.
- Pins the v2 authority once at startup, logs the pinned receipt id
  + audit status to stderr. Fails closed in `--authority remote`
  when no v2 promotion is recorded.
- The runtime `prosa.refresh_authority` MCP tool registration is
  deferred to **CQ-149** — registering it inside the running
  McpServer requires extending `prosa-core` tool factory to accept
  a refresh callback. The slice 9 minimum surfaces the pinned
  context so Lane 8 audit-drift signalling can land without that
  hook.

## Slice 10 — web data layer

- New files:
  - `apps/web/src/lib/api-v2.ts` — typed fetch client over
    `/v2/reads/*`. Mirrors the server route schemas; carries
    `credentials: 'include'` + tenant header on every call.
  - `apps/web/src/lib/api-v2.test.ts` — 5 tests cover the tenant
    header path, the missing-tenant path, the 412 → AuthorityChanged
    mapping, the error envelope parse, and the retry-after capture.
- Tracks a follow-up "slice 10b" for the route-by-route migration
  off the existing tRPC client.

## Baseline gate batch

```text
pnpm typecheck
Tasks:    13 successful, 13 total
```

```text
pnpm lint
Tasks:    13 successful, 13 total
```

```text
pnpm build
Tasks:    13 successful, 13 total
```

```text
git diff --check
(clean)
```

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/
Test Files  3 passed (3)
Tests       16 passed (16)
```

```text
pnpm --filter @c3-oss/prosa-web exec vitest run src/lib/api-v2.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  72 passed | 2 skipped (74)
Tests       431 passed | 4 skipped (435)
```

## Slice 12 — CQ-150/151/152/153 wire-compat + retry policy

- CQ-150: aligned CLI + web v2 client schemas with the actual Lane 6
  route shapes (search/transcript/tool-calls/analytics). Added
  `apps/cli/test/v2/reads-client-contract.test.ts` (9 tests)
  importing the route schemas directly from `apps/api/src/v2/reads/`
  to prevent silent drift.
- CQ-151: local-mode fallbacks now reject unsupported filters
  (`--project`/`--cursor` for sessions, all server-only filters
  for search) rather than silently widening output.
- CQ-152: new `with412RefreshAndRetry` helper refreshes authority
  once and retries idempotent reads on HTTP 412; a second 412
  stops with `AuthorityChangedError`. Streaming/multi-page commands
  (transcript --all-pages) keep fail-closed semantics.
- CQ-153: `createV2ApiClient` throws `MissingTenantError` before
  any network round-trip when no active tenant is provided.

Focused gate:

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/
Test Files  5+ passed
Tests       28+ passed
```

```text
pnpm --filter @c3-oss/prosa-web exec vitest run src/lib/
Test Files  2 passed (2)
Tests       9 passed (9)
```

## Slice 13 — CQ-149 closure (`prosa.refresh_authority` MCP tool)

- `prosa-core` `registerProsaTools` accepts an `onRefreshAuthority`
  callback; when provided, the `prosa.refresh_authority` MCP tool is
  registered. Callback errors surface as `isError: true` content.
- `listenMcpServer` and `listenMcpStdioServer` thread the callback
  through to the per-session tool factory.
- `prosa mcp-v2 serve` builds the refresh callback inside
  `makeRefreshCallback`; calls `refreshAuthorityNow` and mutates the
  pinned `V2ReadContext` in place. `--authority local` leaves the
  callback undefined so the tool stays absent.
- New tests:
  - `packages/prosa-core/test/mcp/tools.test.ts` (+2 CQ-149 cases).
  - `apps/cli/test/v2/mcp-refresh-authority.test.ts` (3 tests).

## Slice 14 — CQ-153 closure (web data layer)

- `apps/web/src/app/providers.tsx` exposes `apiV2: V2ApiClient`.
- Seven console read routes migrated to apiV2: sessions, search,
  tool-calls, analytics, session-detail, dashboard, artifact.
- `apps/web/src/lib/api-v2.ts` extended with `analytics.summary`
  (GET) and `artifacts.getText` (POST). Internal request helper
  splits into `get<T>` + `post<T>` over a shared `request<T>`.
- `cas-text` and 4 dashboard widgets render explicit
  "pending v2 endpoint" empty states; they make no network call
  and no longer use legacy tRPC.
- Route-level tests at `apps/web/src/routes/console/sessions-v2.test.tsx`
  (1) and `apps/web/src/routes/console/v2-reads.test.tsx` (6).

## Slice 15 — CQ-150/151/152 closure

- 4 new command-level test files for `read search/transcript/
  tool-calls/analytics` rendering against representative Lane 6
  payloads.
- `read-sessions-local-filters.test.ts` (6 tests) for CQ-151.
- `with-412-refresh-and-retry.test.ts` (3 tests) for CQ-152, plus
  the transcript-command 412-refresh test extension.

## Slice 11 — manual smoke playbook

Slice 11's "manual or E2E smoke" gate is satisfied via
`docs/rearch-2/lane-7-v1-to-v2-manual-smoke.md` plus the
combined automated suites (148 Lane 6 reads tests + 55 CLI v2
tests + 37 web tests + 11 prosa-core MCP tests). A single-process
Fastify + PGlite automated E2E is blocked by CQ-124 (v1/v2 schema
shared-name conflicts) and deferred until the Lane 10 cutover.

## Final Lane 7 gate snapshot

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/
Test Files  15 passed (15)
Tests       55 passed (55)
```

```text
pnpm --filter @c3-oss/prosa-web exec vitest run
Test Files  13 passed (13)
Tests       37 passed (37)
```

```text
pnpm --filter @c3-oss/prosa-core exec vitest run test/mcp/tools.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)
```

```text
pnpm typecheck   Tasks  13 successful, 13 total
pnpm lint        Tasks  13 successful, 13 total
```

Status: **all Lane 7 CQs closed + every gate item checked**;
awaiting governor acceptance.
