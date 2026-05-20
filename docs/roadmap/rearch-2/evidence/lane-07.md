# Lane 7 Evidence — CLI and MCP

Status: in progress.

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

## Open slices

- Slice 9 — `prosa mcp serve --authority {auto|local|remote}` and
  `prosa.refresh_authority` MCP tool.
- Slice 10 — `apps/web` data layer rewrite onto `/v2/reads/*`.
- E2E smoke: live Fastify harness exercising each `prosa read *`
  command against `/v2/reads/*` end-to-end (slice 11).
- Lane 7 baseline gate batch (`pnpm install --frozen-lockfile`,
  `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`,
  `git diff --check`).
