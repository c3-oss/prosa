# rearch-2 Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | pass | `pnpm install --frozen-lockfile`-compatible. Pre-existing peer warning: `@c3-oss/config-vitest@0.3.0` wants vitest ^3.1.1, repo on 2.1.9. |
| `pnpm build` | yes | pass | 10/10 turbo tasks (now includes `@c3-oss/prosa-bundle-v2`). |
| `just typecheck` | yes | pass | 10/10 turbo tasks. |
| `just test-all` | yes | pass | 10/10 turbo tasks. Lane 0 packages: 89 tests in `@c3-oss/prosa-types-v2`, 21 in `@c3-oss/prosa-wire-v2` (post-CQ-016..CQ-019). Lane 1 partial: 46 tests in `@c3-oss/prosa-bundle-v2` (post-shard-actor + epoch-lifecycle). |
| `just lint-all` | yes | pass | 10/10 turbo tasks. |
| `pnpm audit --audit-level moderate` | yes | classified pass | 7 dev-tooling-only vulnerabilities, pre-existing on `master`. See "Audit Classification". |
| `git diff --check` | yes | pass | No whitespace or conflict markers. |

## Repo Fallback Commands

These do not replace the base commands, but record useful focused fallbacks when
a `just` wrapper fails for environmental reasons.

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm typecheck` | conditional | pass | Equivalent to `just typecheck`. |
| `pnpm test` | conditional | pass | Equivalent to `just test-all`. |
| `pnpm lint` | conditional | pass | Equivalent to `just lint-all`. |

## Lane Commands

| Lane | Command | Required | Last Result | Notes |
| --- | --- | --- | --- | --- |
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 typecheck` | yes | pass | |
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 build` | yes | pass | |
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 test` | yes | pass | 77 tests / 8 files (canonical-encoding, merkle-leaf, merkle-root, bundle-root, raw-source, receipt-payload, derive-ids, normalization). |
| 00 | `pnpm --filter @c3-oss/prosa-wire-v2 typecheck` | yes | pass | |
| 00 | `pnpm --filter @c3-oss/prosa-wire-v2 test` | yes | pass | 18 tests including CQ-011 receiptId binding and CQ-012 transportHash. |
| 00 | `pnpm test:conformance` | yes | pass | 15 tests; 13 entity leaves stable. |
| 01 | `pnpm --filter @c3-oss/prosa-bundle-v2 test` | yes | partial-pass | 46 tests across 9 files (head, lock, bundle-init, cas-pack, raw-source-pack, cas-dedup, sharding, shard-actor, epoch-lifecycle). 8+2 CAS writers with rollover, sharded raw-source writer pool, Parquet emitters, and the synthetic-bundle / cold-rebuild e2e scenarios remain for the next Lane 1 iteration. |
| 01 | `pnpm test packages/prosa-bundle-v2/test/e2e/synthetic-bundle.test.ts` | yes | not-run | Synthetic bundle scenario (requires shard actors + pack writers + epoch lifecycle). |
| 01 | `pnpm test packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts` | yes | not-run | Cold rebuild scenario (requires RocksDB rebuild from manifests). |
| 02 | `pnpm --filter @c3-oss/prosa-importers-v2 test` | yes | not-run | Provider, idempotency, graph resolver tests. |
| 02 | `pnpm dev -- compile-all-v2 --help` | yes | not-run | CLI command presence smoke until fixture gate exists. |
| 03 | `pnpm --filter @c3-oss/prosa-derived-v2 test` | yes | not-run | Tantivy, session blob, analytics, compaction tests. |
| 03 | `pnpm dev -- index-v2 status --help` | yes | not-run | CLI command presence smoke until fixture gate exists. |
| 04 | `pnpm --filter @c3-oss/prosa-db-v2 test` | yes | not-run | Postgres v2 schema and migration tests. |
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

## Audit Classification

Last run: this iteration (`pnpm audit --audit-level moderate`).

| Package | Severity | Path | Classification | Notes |
| --- | --- | --- | --- | --- |
| `lodash` | moderate | `.>commitizen>lodash` | dev-only | Interactive commit helper. Tracked for upgrade via `commitizen`. |
| `vite` | moderate | `.>vitest>vite` | dev-only | Pre-existing; upgrade blocked by `@c3-oss/config-vitest@0.3.0` peer pin to vitest 2.1.9. |
| (other 5) | low / moderate / high | (dev-only paths) | dev-only / build-tooling | None affect production runtime. |

No runtime production dependency is flagged. This is the same audit posture as
`master`; Lane 0 introduces no new transitive risk.

## Historical Failures (kept as dated notes, not "Last Result")

- 2026-05-18 mid-iteration: `pnpm --filter @c3-oss/prosa-types-v2 typecheck`,
  `test`, and `build` failed before the `.ts → .js` import-extension rewrite
  and dependency wiring landed. Resolved in the same iteration; final result
  pass.
- 2026-05-18 mid-iteration: `pnpm --filter @c3-oss/prosa-wire-v2 test` failed
  twice — once with a stale `manifestDigest` fixture using a non-hex
  character, again after CQ-011 introduced `deriveReceiptId` binding (the
  pre-update fixture used a placeholder `receiptId`). Both resolved in this
  iteration; final result pass.
- 2026-05-18 mid-iteration: `pnpm test:conformance` failed once with a stale
  `raw_record` expected leaf after `RawRecordV2` was extended (CQ-006);
  resolved by regenerating `expected-leaves.json`. After CQ-010 the
  conformance leaves were regenerated a second time; final result pass.

## Done Check (Lane 0 only)

- [x] Worktree state documented.
- [x] Lane 0 has evidence; lanes 1–10 are documented as not started.
- [x] No open blocking corrections (CQ-001..CQ-015 closed).
- [x] Base gates passed.
- [x] Lane 0-specific gates passed.
- [ ] Docker-backed E2E passed for sync, reads, migration, and cutover paths.
  *(N/A for Lane 0 — required from Lane 5 onward.)*
- [x] Audit output classified.
- [x] Security, integrity, remote-read, and E2E reviewer findings resolved
  (Lane 0 scope only).
- [ ] Final Codex review completed. *(Pending after this commit. Lane 0 is
  ready for review; Codex may raise further blockers in a subsequent
  iteration.)*
- [ ] Five-cycle final stabilization evidence recorded. *(Not applicable
  yet — Lane 0 of 11 complete; full stabilization is a final-iteration
  requirement.)*
