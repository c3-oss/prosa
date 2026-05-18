# rearch-2 Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | pass | `pnpm install --frozen-lockfile`-compatible. Pre-existing peer warning: `@c3-oss/config-vitest@0.3.0` wants vitest ^3.1.1, repo on 2.1.9. |
| `pnpm build` | yes | pass | 10/10 turbo tasks (now includes `@c3-oss/prosa-bundle-v2`). |
| `just typecheck` | yes | pass | 10/10 turbo tasks. |
| `just test-all` | yes | pending re-run | Pre CQ-036..CQ-043 closeout counts: 89 in `@c3-oss/prosa-types-v2`, 21 in `@c3-oss/prosa-wire-v2`, 86 in `@c3-oss/prosa-bundle-v2`. Working tree (pending closeout commit): **91** in `@c3-oss/prosa-bundle-v2` (added CQ-042 canonical-header rejection x2 across cas-pack and raw-source-pack, + CQ-043 rebuild drift-rejection x1). Full `just test-all` re-run will land with the closeout commit. |
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
| 01 | `pnpm --filter @c3-oss/prosa-bundle-v2 test` | yes | partial-pass | 74 tests across 14 files (head, lock, bundle-init, cas-pack with CQ-026 forged-digest rejection, raw-source-pack, cas-dedup, sharding, shard-actor, epoch-lifecycle with CQ-023/CQ-024/CQ-025 durability + FK closure + stale-tmp reap, cas-writer, raw-source-writer, zstd-frame with CQ-027 window enforcement, projection-segment, e2e/synthetic-seal). Cold rebuild and the 1k-session synthetic-bundle / cold-rebuild scenarios remain for the next Lane 1 iteration. |
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

## Done Check (Lane 0 + Lane 1 partial)

- [x] Worktree state documented.
- [x] Lane 0 has evidence; lanes 1–10 are documented as not started or WIP.
- [ ] No open blocking corrections. *(`CQ-036`..`CQ-043` fixes applied in
  working tree, awaiting Codex re-review acceptance; `CQ-044` keeps Lane 2+
  work containerized as out-of-sequence WIP.)*
- [x] Base gates passed (last full run pre CQ-036..CQ-043).
- [x] Lane 0-specific gates passed.
- [x] Lane 1 focused gates: `pnpm --filter @c3-oss/prosa-bundle-v2 typecheck`
  pass; `pnpm --filter @c3-oss/prosa-bundle-v2 test` 91/91 pass.
- [ ] Docker-backed E2E passed for sync, reads, migration, and cutover paths.
  *(N/A until Lane 5+.)*
- [x] Audit output classified.
- [x] Security, integrity, remote-read, and E2E reviewer findings resolved
  for Lane 0 (CQ-001..CQ-019).
- [ ] Final Codex review completed. *(Pending re-review after the
  `CQ-036`..`CQ-043` closeout commit.)*
- [ ] Five-cycle final stabilization evidence recorded. *(Pending; Lane 1
  must be accepted by Codex first.)*
