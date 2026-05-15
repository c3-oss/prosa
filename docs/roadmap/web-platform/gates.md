# Web Platform Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | passed | Install from `pnpm-lock.yaml`. Re-run after every dependency change. |
| `pnpm build` | release-only | passed | Full Turbo build is part of the release checklist, not per-iteration. `pnpm --filter @c3-oss/prosa-api build` (re-run this iteration) covers the web E2E webServer boot path. |
| `just typecheck` | release-only | classified | Aggregated gate; equivalent per-package typechecks (`pnpm --filter @c3-oss/prosa-api typecheck`, `pnpm --filter @c3-oss/prosa-web typecheck`) are re-run for every code change in those packages. |
| `just test-all` | release-only | classified | Aggregated gate; per-package tests below are re-run per-iteration and cover the changed surface. |
| `just lint-all` | release-only | classified | Aggregated gate; per-package lints re-run when code changes. |
| `pnpm audit --audit-level moderate` | yes | classified | Findings (lodash via commitizen, esbuild via vitest/drizzle-kit, vite via vitest) are all in dev tooling / transitive — no runtime exposure. |
| `git diff --check` | yes | passed | Re-run at the end of every correction iteration including this one. |

## Domain Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `just e2e-up` | no (scoped out) | not-run | Server-sync Docker E2E harness; owned by the server-sync lane, not the web roadmap. Codex accepted this scope: this lane changes the browser surface and read API, both covered by per-package tests + browser E2E. The Docker matrix exercises Postgres/MinIO/CLI sync which is unchanged. |
| `just e2e` | no (scoped out) | not-run | Same scope decision. |
| `just e2e-cli` | no (scoped out) | not-run | Same scope decision. |
| `just e2e-down` | no (scoped out) | not-run | Teardown for the above; only runs if the matrix is started. |
| `pnpm --filter @c3-oss/prosa-web typecheck` | yes | passed | Browser app type gate. |
| `pnpm --filter @c3-oss/prosa-web build` | yes | passed | Browser app production build. |
| `pnpm --filter @c3-oss/prosa-web test` | yes | passed | Browser component/unit tests. |
| `pnpm --filter @c3-oss/prosa-api typecheck` | yes | passed | API type gate. |
| `pnpm --filter @c3-oss/prosa-api build` | yes | passed | API ESM build — required for the Playwright webServer to boot via the built dist. |
| `pnpm --filter @c3-oss/prosa-api test` | yes | passed | Full API test suite. |
| `pnpm --filter @c3-oss/prosa-api exec vitest run test/device-auth.test.ts test/verifier-fixes.test.ts test/reads-v0.test.ts test/verified-provenance.test.ts test/correction-fixes.test.ts` | yes | passed | Focused CQ correction gate covering CQ-003..CQ-011. |
| `pnpm --filter @c3-oss/prosa exec vitest run test/cli/remote-authority.test.ts test/cli/remote-authority-routing.test.ts` | yes | passed | CLI remote-authority gate. |
| `pnpm --filter @c3-oss/prosa-web exec playwright test e2e/authenticated.spec.ts e2e/marketing.spec.ts --reporter=list` | yes | passed | Browser E2E — both specs cover the verified-projection v0 contract. |

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
| 08 | Per-package gates, browser E2E, focused CQ correction gates. The Docker-backed `just e2e*` matrix is `no (scoped out)` for this roadmap iteration and is owned by the server-sync lane. |

## Done Check

- [x] Worktree state documented in `status.md`.
- [x] All lanes have evidence under `evidence/`.
- [x] No open blocking corrections (`correction-queue.md`).
- [x] Web package gates passed.
- [x] API package + focused CQ correction gates passed.
- [x] Browser E2E (`authenticated.spec.ts`, `marketing.spec.ts`) passed.
- [x] Audit output classified (dev tooling / transitive).
- [x] Lane-08 evidence and this gate matrix agree about which gates ran,
  which are release-only, and which are scoped out.
- [x] No gate is marked `Required: yes` while also being `out-of-scope` or
  `not-run`.
