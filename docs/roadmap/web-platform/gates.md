# Web Platform Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | passed | Install from `pnpm-lock.yaml`. |
| `pnpm build` | yes | passed | Last full Turbo build before CQ correction iterations; not re-run for documentation-only edits. |
| `just typecheck` | yes | passed | Per-package typechecks have been re-run for every code change in `apps/api` and `apps/web`. |
| `just test-all` | yes | passed | Per-package tests have been re-run for every code change; see Domain Commands below. |
| `just lint-all` | yes | passed | Last full Biome pass before correction iteration; not re-run for documentation-only edits. |
| `pnpm audit --audit-level moderate` | yes | classified | Findings (lodash, esbuild, vite) all in dev tooling / transitive — no runtime exposure. |
| `git diff --check` | yes | passed | Re-run at the end of this correction iteration. |

## Domain Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `just e2e-up` | yes | out-of-scope | Server-sync Docker E2E harness; not in scope for the web roadmap iteration. |
| `just e2e` | yes | out-of-scope | Same as above. |
| `just e2e-cli` | yes | out-of-scope | Same as above. |
| `just e2e-down` | yes | out-of-scope | Same as above. |
| `pnpm --filter @c3-oss/prosa-web typecheck` | yes | passed | Browser app type gate. |
| `pnpm --filter @c3-oss/prosa-web build` | yes | passed | Browser app production build. |
| `pnpm --filter @c3-oss/prosa-web test` | yes | passed | Browser component/unit tests. |
| `pnpm --filter @c3-oss/prosa-api test` | yes | passed | API integration/read/auth tests. |
| `pnpm --filter @c3-oss/prosa-api exec vitest run test/verifier-fixes.test.ts test/reads-v0.test.ts test/verified-provenance.test.ts` | yes | passed | Focused CQ correction gate. |
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
| 08 | Per-package gates, browser E2E, focused CQ correction gates. The Docker-backed `just e2e*` matrix is out of scope for this roadmap iteration and is owned by the server-sync lane. |

## Done Check

- [x] Worktree state documented in `status.md`.
- [x] All lanes have evidence under `evidence/`.
- [x] No open blocking corrections (`correction-queue.md`).
- [x] Web package gates passed.
- [x] API package + focused CQ correction gates passed.
- [x] Browser E2E (`authenticated.spec.ts`, `marketing.spec.ts`) passed.
- [x] Audit output classified (dev tooling / transitive).
- [x] Lane-08 evidence and this gate matrix do not contradict each
  other or `authenticated.spec.ts`.
