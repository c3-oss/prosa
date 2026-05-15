# Ralph Loop: Web Platform

You are implementing the `docs/roadmap/web-platform` roadmap in this repository.

Codex is acting as architect and gatekeeper. It may update correction and gate
files while you work. Treat those files as blocking input. Ralph/Claude executes
implementation; Ralph must not be the final judge of Done.

Codex is actively reviewing this implementation with focused subagents. Reviewer
findings in `correction-queue.md` are blocking steering input, not optional
notes. Close every blocking correction with code, tests, and evidence before
continuing new feature work or declaring `RALPH_DONE`.
Codex will reject `RALPH_DONE` while any subagent finding remains open or lacks
test/gate evidence.

## Read First

- AGENTS.md
- docs/README.md
- docs/roadmap/web-platform/
- .codex/skills/prosa-dev-workflow/SKILL.md
- .codex/skills/prosa-server-sync/SKILL.md
- .codex/skills/prosa-search-export/SKILL.md
- docs/architecture/server-sync.md
- docs/architecture/search-engines.md
- docs/architecture/bundle-format.md
- docs/architecture/analytics.md

## Product Contract

- Build the web platform lane-by-lane in the order defined by the roadmap.
- `apps/web` is a private Vite React SPA named `@c3-oss/prosa-web`.
- The web app consumes `apps/api` through typed tRPC and browser Better Auth
  flows; do not create a parallel web-only auth system.
- Browser sessions are cookie-based. Do not store session tokens, auth headers,
  invite links, or cookies in localStorage, logs, or fixtures.
- Console reads are authenticated, tenant-scoped, and based on verified promoted
  remote data. Local bundle browsing stays CLI/TUI-first in web v0.
- The server remains remote-authoritative for promoted data. Do not make the
  browser or CLI re-derive canonical projection data for console reads.
- Every read endpoint must validate tenant membership server-side. A client
  `x-prosa-tenant-id` is only a candidate.
- Artifact/object reads must prove verified tenant ownership and must not expose
  raw storage keys.
- `sessions.detail` is the primary session-detail API. The console timeline
  must not parse Markdown export as its data model.
- Search v0 uses remote Postgres FTS over `search_doc` metadata. Tantivy remains
  local/sidecar for now.
- Parquet/DuckDB, MCP management, and browser-triggered compile/import are out
  of scope for web v0.
- Public routes must render without API availability. Console routes must fail
  closed on auth, tenant, or API authorization errors.
- Prefer existing repo patterns, strict TypeScript, ESM imports, Biome style,
  and focused tests next to changed behavior.

## Work Lanes

Implement exactly one lane at a time, in this order. Do not skip ahead unless
the current lane is blocked and the blocker is recorded in `correction-queue.md`.

1. **Lane 01: Product surface and visual system**
   - Confirm the route map, product model, visual tokens, typography, layout
     primitives, component vocabulary, and deferred surfaces from
     `01-product-surface.md`.
   - If implementation reveals an ambiguity, update the roadmap doc before
     depending on the decision in code.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-01.md`.

2. **Lane 02: Frontend foundation**
   - Add `apps/web` with Vite, React, TypeScript, TanStack Router, TanStack
     Query, tRPC React client, browser auth wrapper, CSS tokens, global styles,
     route groups, providers, primitives, and initial placeholder routes.
   - Compile against `AppRouter` exported by `@c3-oss/prosa-api`.
   - Ensure the landing route works without the API server.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-02.md`.

3. **Lane 03: Browser auth and tenancy**
   - Wire signup, login, logout, session hydration, tenant selection, tenant
     switching, admin invite flow, and team settings against the existing API.
   - Confirm or implement API CORS/trusted-origin support for browser
     credentialed requests.
   - Keep CLI bearer/device auth separate from browser cookie auth.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-03.md`.

4. **Lane 04: Read API v0**
   - Add or extend tRPC procedures: `sessions.list`, `sessions.count`,
     `sessions.detail`, `search.query`, `toolCalls.list`, `artifacts.getText`,
     and `analytics.report`.
   - Use stable camelCase response shapes and cursor pagination.
   - Gate every procedure on authenticated tenant membership and verified
     promoted data.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-04.md`.

5. **Lane 05: Console shell and sessions**
   - Implement `/console` and `/console/sessions` with authenticated layout,
     tenant-aware navigation, dashboard summary cards, session table, filters,
     pagination, loading states, empty states, and mobile behavior.
   - Data must come from remote API calls, not fake console data.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-05.md`.

6. **Lane 06: Session detail timeline**
   - Implement `/console/sessions/:sessionId` using `sessions.detail`.
   - Render ordered timeline events for messages, content blocks, tool calls,
     tool results, artifacts, system/unknown events, and object refs.
   - Keep large output bounded and preview full content only through authorized
     object/artifact APIs.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-06.md`.

7. **Lane 07: Search, analytics, and artifacts**
   - Implement `/console/search`, `/console/tool-calls`, `/console/analytics`,
     artifact preview page/drawer, URL-backed filters, cursor pagination, and
     result/detail links.
   - Expose all five existing analytics report semantics remotely.
   - Keep Parquet/DuckDB/MCP/compile surfaces out of the browser.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-07.md`.

8. **Lane 08: Production readiness**
   - Add deployment configuration docs, production env validation, credentialed
     CORS/trusted-origin behavior, observability/error handling, browser E2E,
     accessibility/performance/security gates, and release evidence.
   - Prove signup, login, empty tenant, seeded/promoted tenant, sessions,
     detail, search, analytics, artifact authorization, and logout end to end.
   - Evidence: `docs/roadmap/web-platform/evidence/lane-08.md`.

At the start of each iteration:

- inspect `git status --short --branch`;
- read `docs/roadmap/web-platform/status.md`;
- read `docs/roadmap/web-platform/correction-queue.md`;
- prioritize every open `Blocking: yes` correction over new lane work;
- identify the first incomplete lane or open blocking correction;
- continue from there without restarting completed work;
- preserve user changes and unrelated agent changes;
- do not touch generated directories by hand.

## Required Files

Keep these files current:

- `docs/roadmap/web-platform/status.md`
- `docs/roadmap/web-platform/correction-queue.md`
- `docs/roadmap/web-platform/gates.md`
- `docs/roadmap/web-platform/evidence/lane-01.md`
- `docs/roadmap/web-platform/evidence/lane-02.md`
- `docs/roadmap/web-platform/evidence/lane-03.md`
- `docs/roadmap/web-platform/evidence/lane-04.md`
- `docs/roadmap/web-platform/evidence/lane-05.md`
- `docs/roadmap/web-platform/evidence/lane-06.md`
- `docs/roadmap/web-platform/evidence/lane-07.md`
- `docs/roadmap/web-platform/evidence/lane-08.md`

After each lane:

- update the lane evidence file with commits, tests, data/security proof, known
  risks, and reviewer notes;
- update `status.md` with lane status and current HEAD;
- run focused checks for the lane;
- make a coherent commit for that lane when the work is complete and tested.

## Implementation Rules

- Use `pnpm` from a `devbox shell` when possible.
- Use Node 22-compatible TypeScript and ESM imports.
- Use named exports and `import type` for type-only imports.
- Respect Biome style: 2-space indentation, single quotes, semicolons, trailing
  commas, and 100-column line width.
- Do not hand-edit `dist/`, `coverage/`, `node_modules/`, `.turbo/`, or
  `.devbox/`.
- Add or update focused tests with every meaningful behavior change.
- Keep fixtures deterministic and small.
- Do not point manual checks at a real user `~/.prosa` store.
- Add a Changeset for user-facing package behavior when required by the repo's
  release workflow; document if a lane intentionally does not need one.
- If a command cannot run, document the blocker and a reproducible fallback in
  the relevant evidence file.

## Required Gates

Before Done, run or explicitly classify:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
pnpm audit --audit-level moderate
git diff --check
```

Because this work touches the server-sync/auth/read stack, also run:

```text
just e2e-up
just e2e
just e2e-cli
just e2e-down
```

Because this work creates a browser app, also run:

```text
pnpm --filter @c3-oss/prosa-web typecheck
pnpm --filter @c3-oss/prosa-web build
pnpm --filter @c3-oss/prosa-web test
pnpm --filter @c3-oss/prosa-api test
```

Lane 08 must add and run the browser E2E command it introduces.

Classify audit findings as runtime, production, dev tooling, or transitive.

## Completion Rule

Only satisfy the completion promise when every lane is implemented, every
blocking correction is closed with evidence, required gates are green or
classified, and worktree state is documented. With the Ralph Loop plugin, that
means outputting exactly:

```text
<promise>RALPH_DONE</promise>
```
