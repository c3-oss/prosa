# Web Platform Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | not-run | Install from `pnpm-lock.yaml`. |
| `pnpm build` | yes | not-run | Turbo build for all workspace packages. |
| `just typecheck` | yes | not-run | Full TypeScript gate. |
| `just test-all` | yes | not-run | Full Vitest gate. |
| `just lint-all` | yes | not-run | Full Biome gate. |
| `pnpm audit --audit-level moderate` | yes | not-run | Classify findings as runtime, production, dev tooling, or transitive. |
| `git diff --check` | yes | not-run | Whitespace and patch hygiene. |

## Domain Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `just e2e-up` | yes | not-run | Start Postgres + MinIO server-sync E2E harness. |
| `just e2e` | yes | not-run | API + Postgres + object store E2E. |
| `just e2e-cli` | yes | not-run | CLI two-device sync/read E2E. |
| `just e2e-down` | yes | not-run | Teardown, even after failed E2E. |
| `pnpm --filter @c3-oss/prosa-web typecheck` | yes | not-run | Browser app type gate. |
| `pnpm --filter @c3-oss/prosa-web build` | yes | not-run | Browser app production build. |
| `pnpm --filter @c3-oss/prosa-web test` | yes | not-run | Browser component/unit tests. |
| `pnpm --filter @c3-oss/prosa-api test` | yes | not-run | API integration/read/auth tests. |
| Browser E2E command added by lane 08 | yes | not-run | Must cover signup, login, console, sessions, detail, search, analytics, logout. |

## Focused Lane Checks

| Lane | Expected Focused Checks |
| --- | --- |
| 01 | Documentation consistency check and `git diff --check`. |
| 02 | `pnpm --filter @c3-oss/prosa-web typecheck`, `pnpm --filter @c3-oss/prosa-web build`, `pnpm --filter @c3-oss/prosa-web test`. |
| 03 | Web auth tests, API auth/tenant tests, CORS/trusted-origin tests. |
| 04 | API read tests for pagination, filters, tenant isolation, verified-data gating, artifact authorization. |
| 05 | Web console/session tests and focused API fixtures for dashboard/session list. |
| 06 | Web timeline renderer tests and API session-detail tests for all event kinds and large output refs. |
| 07 | Web search/tool/analytics/artifact tests and API search/tool/analytics/artifact tests. |
| 08 | Full gates, Docker-backed E2E, browser E2E, accessibility/performance/security release checks. |

## Done Check

- [ ] Worktree state documented.
- [ ] All lanes have evidence.
- [ ] No open blocking corrections.
- [ ] Domain gates passed or blockers are documented.
- [ ] Web package gates passed.
- [ ] Browser E2E passed or blocker is documented.
- [ ] Audit output classified.
- [ ] Final Codex review completed.
