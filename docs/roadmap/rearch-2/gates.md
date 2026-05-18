# rearch-2 Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | pass | `pnpm install --frozen-lockfile`-compatible. Pre-existing peer warning: `@c3-oss/config-vitest@0.3.0` wants vitest ^3.1.1, repo on 2.1.9. |
| `pnpm build` | yes | pass | 10/10 turbo tasks (now includes `@c3-oss/prosa-bundle-v2`). |
| `just typecheck` | yes | pass | 10/10 turbo tasks. |
| `just test-all` | yes | pass | 12/12 turbo at HEAD post-CQ-063. Focused counts: `@c3-oss/prosa-types-v2` 89, `@c3-oss/prosa-wire-v2` 21, conformance 15, `@c3-oss/prosa-bundle-v2` **114** (Lane 1 hardening: CQ-042 x2 + CQ-043 x1 + CQ-046 x4 + CQ-047 x2 + CQ-048 x3 + CQ-049 x2 + CQ-050 x2 + CQ-053 x2 + CQ-054 x1 + CQ-056 x2 + CQ-057 x1 + CQ-058 x1 + CQ-060 x1 + CQ-061 x1 + CQ-063 x1), `@c3-oss/prosa-importers-v2` 8 (out-of-sequence WIP, CQ-044), `@c3-oss/prosa-db-v2` 6 (out-of-sequence WIP, CQ-044). |
| `just lint-all` | yes | pass | 10/10 turbo tasks. |
| `pnpm audit --audit-level moderate` | yes | classified pass | 8 vulnerabilities found (1 low / 6 moderate / 1 high). All pre-existing on `master`. See "Audit Classification". |
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
| 00 | `pnpm --filter @c3-oss/prosa-types-v2 test` | yes | pass | 89 tests across 8 files (canonical-encoding, merkle-leaf, merkle-root, bundle-root, raw-source, receipt-payload, derive-ids, normalization; +CQ-018 BLAKE3 spec vectors + CQ-014/CQ-022 timestamp/normalization). |
| 00 | `pnpm --filter @c3-oss/prosa-wire-v2 typecheck` | yes | pass | |
| 00 | `pnpm --filter @c3-oss/prosa-wire-v2 test` | yes | pass | 18 tests including CQ-011 receiptId binding and CQ-012 transportHash. |
| 00 | `pnpm test:conformance` | yes | pass | 15 tests; 13 entity leaves stable. |
| 01 | `pnpm --filter @c3-oss/prosa-bundle-v2 test` | yes | pass | 113 tests across 15 files (head, lock, bundle-init, cas-pack with CQ-026 forged-digest + CQ-042 canonical-header rejections, raw-source-pack, cas-dedup, sharding, shard-actor, epoch-lifecycle with CQ-023..CQ-027 durability + CQ-032/CQ-033/CQ-037/CQ-041/CQ-047/CQ-048 FK closure + CQ-038/CQ-049/CQ-051/CQ-054/CQ-058 containment + CQ-039 fsync + CQ-040 CAS counts, cas-writer, raw-source-writer with CQ-047 conflict, zstd-frame, projection-segment, rebuild with CQ-043/CQ-046/CQ-050/CQ-053/CQ-056/CQ-057/CQ-060/CQ-061 integrity, e2e/synthetic-seal). |
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

Last run: this iteration (`pnpm audit --audit-level moderate`). Total: 8
findings (1 low / 6 moderate / 1 high), all pre-existing on `master`.

| Package | Severity | Path | Classification | Notes |
| --- | --- | --- | --- | --- |
| `lodash` (×3) | 1 high + 2 moderate | `.>commitizen>lodash` | dev-only | Interactive commit helper. Tracked for upgrade via `commitizen`. |
| `esbuild` | moderate | `.>vitest>vite>esbuild`, `apps__api>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild` | dev-only / build-tooling | Pre-existing; vitest path blocked by `@c3-oss/config-vitest@0.3.0` peer pin to vitest 2.1.9; drizzle-kit is a dev/migration tool. |
| `vite` | moderate | `.>vitest>vite` | dev-only | Same peer-pin block as above. |
| `ws` | moderate | `apps__cli>ink>ws` | runtime-tooling | CLI TUI dependency via `ink`. Affects the CLI's interactive surface, not server/library code paths. Tracked for upgrade via `ink`. |
| (low/extra) | low | (dev path) | dev-only | One additional low-severity finding on a dev path. |

`ws` via `apps__cli>ink>ws` is the only finding on a non-dev path
(CLI runtime tooling). No server/library production runtime path is
flagged. This is the same audit posture as `master`; Lane 0/1 introduce
no new transitive risk.

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
- [ ] No open blocking corrections. *(Only `CQ-044` remains — procedural Lane 2/4
  containment that clears with Codex's Lane 1 acceptance. All Lane 0 / Lane 1
  integrity corrections `CQ-001..CQ-059` are closed in code, tests, and
  evidence.)*
- [x] Base gates passed at HEAD `f3730b3` (full repo `pnpm test` / `pnpm
  typecheck` / `pnpm lint` 12/12 turbo).
- [x] Lane 0-specific gates passed: `prosa-types-v2` 89 tests, `prosa-wire-v2`
  21 tests, `pnpm test:conformance` 15 tests.
- [x] Lane 1 focused gates: `pnpm --filter @c3-oss/prosa-bundle-v2 typecheck`
  pass; `pnpm --filter @c3-oss/prosa-bundle-v2 test` 111/111 pass.
- [ ] Docker-backed E2E passed for sync, reads, migration, and cutover paths.
  *(N/A until Lane 5+.)*
- [x] Audit output classified (8 findings; only `apps__cli>ink>ws` touches a
  non-dev path, pre-existing on `master`).
- [x] Security, integrity, remote-read, and E2E reviewer findings resolved
  for Lane 0 (`CQ-001..CQ-019`) and Lane 1 integrity (`CQ-020..CQ-059`).
  Latest independent reviewer pass on `f54f4f1` returned ACCEPT — no findings.
- [ ] Final Codex review completed. *(Pending — `CQ-044` clears with the same
  acceptance.)*
- [ ] Five-cycle final stabilization evidence recorded. *(Pending; Lane 1
  must be accepted by Codex first.)*
