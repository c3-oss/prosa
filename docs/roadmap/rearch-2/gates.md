# rearch-2 Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | not-run | Install/update workspace dependencies from lockfile. |
| `pnpm build` | yes | not-run | Full Turbo build. |
| `just typecheck` | yes | not-run | Repo aggregate typecheck. |
| `just test-all` | yes | not-run | Repo aggregate test suite. |
| `just lint-all` | yes | not-run | Repo aggregate lint suite. |
| `pnpm audit --audit-level moderate` | yes | not-run | Classify audit failures as runtime, production, dev tooling, or transitive. |
| `git diff --check` | yes | not-run | Whitespace and conflict-marker check. |

## Repo Fallback Commands

These do not replace the base commands, but record useful focused fallbacks when
a `just` wrapper fails for environmental reasons.

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm typecheck` | conditional | not-run | Fallback for `just typecheck`. |
| `pnpm test` | conditional | not-run | Fallback for `just test-all`. |
| `pnpm lint` | conditional | not-run | Fallback for `just lint-all`. |

## Lane Commands

| Lane | Command | Required | Last Result | Notes |
| --- | --- | --- | --- | --- |
| 00 | `pnpm typecheck` | yes | not-run | Must include new type and wire packages. |
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 typecheck` | yes | pass | Codex rerun passed on 2026-05-18T16:02. |
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 build` | yes | pass | Codex rerun passed on 2026-05-18T16:02. |
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 test` | yes | pass | 75 tests passed on 2026-05-18T16:09. |
| 00 | `pnpm --filter @c3-oss/prosa-wire-v2 test` | yes | fail | 2 tests fail on invalid `manifestDigest` fixtures at 2026-05-18T16:09. |
| 00 | `pnpm test:conformance` | yes | pass | 15 tests passed on 2026-05-18T16:09. |
| 00 | `pnpm test --filter @prosa/types-v2 --filter @prosa/wire-v2` | yes | not-run | Adjust filter names to actual package names if scoped differently. |
| 00 | `pnpm test test/conformance/leaves.test.ts` | yes | not-run | Conformance fixture for canonical Merkle leaves. |
| 01 | `pnpm test --filter @prosa/bundle-v2` | yes | not-run | Bundle, CAS, raw, epoch, cold-rebuild tests. |
| 01 | `pnpm test packages/prosa-bundle-v2/test/e2e/synthetic-bundle.test.ts` | yes | not-run | Synthetic bundle scenario. |
| 01 | `pnpm test packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts` | yes | not-run | Cold rebuild scenario. |
| 02 | `pnpm test --filter @prosa/importers-v2` | yes | not-run | Provider, idempotency, graph resolver tests. |
| 02 | `pnpm dev -- compile-all-v2 --help` | yes | not-run | CLI command presence smoke until fixture gate exists. |
| 03 | `pnpm test --filter @prosa/derived-v2` | yes | not-run | Tantivy, session blob, analytics, compaction tests. |
| 03 | `pnpm dev -- index-v2 status --help` | yes | not-run | CLI command presence smoke until fixture gate exists. |
| 04 | `pnpm test --filter @prosa/db-v2` | yes | not-run | Postgres v2 schema and migration tests. |
| 04 | `pnpm test apps/api/test/v2` | yes | not-run | API v2 schema, auth, signing, validation tests. |
| 05 | `just e2e-up` | yes | not-run | Docker-backed Postgres + object store + API harness. |
| 05 | `just e2e` | yes | not-run | API promotion E2E. |
| 05 | `just e2e-cli` | yes | not-run | CLI promotion and remote read E2E. |
| 05 | `just e2e-down` | yes | not-run | Teardown must run after E2E attempts. |
| 06 | `pnpm test apps/api/test/v2/reads` | yes | not-run | Receipt-pinned read endpoints and fail-closed behavior. |
| 07 | `pnpm test apps/cli/test/v2` | yes | not-run | CLI read commands, authority cache, MCP tests. |
| 07 | `pnpm test apps/web/e2e` | yes | not-run | Web routes against v2 reads. |
| 08 | `pnpm test apps/api/test/v2/audit` | yes | not-run | Audit drift, receipt degrade, repair response. |
| 08 | `pnpm test apps/api/test/v2/gc` | yes | not-run | GC advisory lock and pack deletion safety. |
| 09 | `pnpm test apps/cli/test/v2/migrate` | yes | not-run | Local migration and atomic rename. |
| 09 | `pnpm test apps/api/test/v2/migrate` | yes | not-run | Remote tenant migration. |
| 10 | `pnpm test apps/api/test/v2/cutover` | yes | not-run | Feature flag, rollback, staged rollout. |
| 10 | `pnpm test apps/cli/test/v2/cutover` | yes | not-run | CLI deprecation behavior. |
| 10 | `pnpm test apps/web/e2e/cutover` | yes | not-run | Web route mapping. |

## Done Check

- [ ] Worktree state documented.
- [ ] All lanes have evidence.
- [ ] No open blocking corrections.
- [ ] Base gates passed or blockers are documented.
- [ ] Lane-specific gates passed or blockers are documented.
- [ ] Docker-backed E2E passed for sync, reads, migration, and cutover paths.
- [ ] Audit output classified.
- [ ] Security, integrity, remote-read, and E2E reviewer findings resolved.
- [ ] Final Codex review completed.
- [ ] Five-cycle final stabilization evidence recorded.
