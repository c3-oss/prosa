# rearch-2 Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | pass | `pnpm install --frozen-lockfile`-compatible. Pre-existing peer warning: `@c3-oss/config-vitest@0.3.0` wants vitest ^3.1.1, repo on 2.1.9. |
| `pnpm build` | yes | pass | 13/13 turbo tasks (now includes `@c3-oss/prosa-derived-v2` Lane 3 scaffold). |
| `just typecheck` | yes | pass | 13/13 turbo tasks. |
| `just test-all` | yes | pass | **13/13** turbo at HEAD post-Tantivy checkpoint persistence landing. Focused counts: `@c3-oss/prosa-types-v2` 89, `@c3-oss/prosa-wire-v2` 21, conformance **26** (15 leaves + 6 providers-v2 projection-id + 5 bundle-compile idempotency), `@c3-oss/prosa-bundle-v2` **120**, `@c3-oss/prosa-importers-v2` **40**, `@c3-oss/prosa-derived-v2` **98** (Lane 3: scaffold policies + SessionBlobPackV2 byte layout + Parquet compaction planner + DuckDB analytics view shape contract + Tantivy schema/rebuild planner + projection-bridge with CQ-091 multibyte-preview coverage + cross-page transcript iterator with fragment coalescing + IndexCheckpointV2 canonical-JSON persistence), `@c3-oss/prosa-db-v2` 6. |
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
| 00 | `pnpm --filter @c3-oss/prosa-wire-v2 test` | yes | pass | 21 tests including CQ-011 receiptId binding and CQ-012 transportHash. |
| 00 | `pnpm test:conformance` | yes | pass | **26 tests** / 2 files: 15 canonical leaves (Lane 0) + 6 providers-v2 projection-id idempotency + 5 per-provider CQ-081/CQ-082 bundle-compile idempotency cases (Reserve loss path exercised via `MemoryShardActor`; second-compile pack-file set under `cas/packs/` and `raw_sources/packs/` byte-identical to first compile). |
| 01 | `pnpm --filter @c3-oss/prosa-bundle-v2 test` | yes | pass | 120 tests across 17 files (prior 118 + CQ-066 full-contract stress + real CLI cold-rebuild). |
| 01 | `pnpm test packages/prosa-bundle-v2/test/e2e/synthetic-bundle.test.ts` | yes | pass | 3 tests: CQ-066 full-contract 1k×100k×200k stress with 8 concurrent producers (~28s) + 1k-session full seal + 200-session re-open round-trip. |
| 01 | `pnpm test packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts` | yes | pass | 3 tests: CQ-066 real CLI subprocess (spawns `prosa bundle rebuild-index --store <path>` via `swc-node`) + index/-delete-then-rebuild replay + idempotent double-rebuild. |
| 01 | `pnpm dev -- bundle rebuild-index --store <path> --uuid <uuid>` | yes | pass | CLI command exercises `rebuildIndex` end-to-end and emits manifest JSON to stdout; covered by the real-subprocess E2E above. |
| 02 | `pnpm --filter @c3-oss/prosa-importers-v2 typecheck` | yes | pass | All 5 providers (Codex/Claude/Gemini/Hermes/Cursor) ship full per-record projection on canonical schema fields. Cursor reads real SQLite stores via `better-sqlite3`. |
| 02 | `pnpm --filter @c3-oss/prosa-importers-v2 test` | yes | pass | 40 tests / 7 files (GraphResolver 5, orchestrator 3, CodexProvider 7, ClaudeProvider 7 incl. CQ-068 spawned-edge tests, CursorProvider 5 incl. CQ-070 stable-key fix + CQ-074 full-projection assertions over a real SQLite store, GeminiProvider 6, HermesProvider 7). |
| 02 | `pnpm --filter @c3-oss/prosa exec vitest run test/cli/compile-v2.test.ts` | yes | pass | 5 subprocess-spawned tests: `compile-v2 codex` happy path + invalid-provider rejection + `compile-all-v2` against all 5 providers + CQ-072 `--help` smokes for both commands. |
| 02 | `pnpm --filter @c3-oss/prosa lint` | yes | pass | CQ-073: formatting issue auto-fixed by `biome check --fix`; lane-02 CLI lint clean. |
| 03 | `pnpm --filter @c3-oss/prosa-derived-v2 test` | yes | pass | **98 tests** / 11 files: SessionBlobPackV2 joint-constraint policy (11) + Parquet compaction trigger policy (6) + framing tests (8; CQ-084) + writer/reader round-trip (11; CQ-085) + Parquet compaction planner (8) + DuckDB analytics views shape contract incl. CQ-089 live+compacted overlay (11) + Tantivy schema/fingerprint (7) + Tantivy rebuild-plan state machine (10) + SessionBlobPackV2 projection-to-input bridge (9: 7 baseline + 2 CQ-091 UTF-8-byte regressions) + SessionBlobPackV2 cross-page transcript iterator (7: empty pack, single/multi-page ordinal walk, fragment coalescing, range filters, lazy termination, tamper rejection) + IndexCheckpointV2 persistence (10: missing-file null, missing-file empty fallback, populated round-trip, empty round-trip, canonical-JSON byte-identity across bundles, atomic overwrite, malformed-JSON rejection, JSON-array rejection, wrong-typed numeric rejection, unexpected-status rejection). Tantivy native binding + DuckDB runtime executor + runtime Parquet merge still pending. |
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

## Done Check (Lane 0 + Lane 1 Full Scope)

- [x] Worktree state documented.
- [x] Lane 0 has evidence; lanes 2–10 are documented as blocked or WIP.
- [ ] No open blocking corrections. *(`CQ-091` and `CQ-092` closed at
  `585a456` + this iteration's reconciliation commit; Lane 2 acceptance
  still pending Codex/governor/user sign-off.)*
- [x] Base gates passed at HEAD `6c25966` (full repo `pnpm test` / `pnpm
  typecheck` / `pnpm lint` 12/12 turbo).
- [x] Lane 0-specific gates passed: `prosa-types-v2` 89 tests, `prosa-wire-v2`
  21 tests, `pnpm test:conformance` 15 tests.
- [x] Lane 1 focused gates all passed. Current bundle-v2 focused tests pass at
  120 tests after the CQ-066 stress and real CLI cold-rebuild additions.
- [ ] Docker-backed E2E passed for sync, reads, migration, and cutover paths.
  *(N/A until Lane 5+.)*
- [x] Audit output classified (8 findings; only `apps__cli>ink>ws` touches a
  non-dev path, pre-existing on `master`).
- [ ] Security, integrity, remote-read, and E2E reviewer findings resolved
  for Lane 0 and Lane 1. Lane 0 / Lane 1 corrections through `CQ-066` are
  closed; Lane 2 closeout (`CQ-074..CQ-082`) and Lane 3 byte layout +
  planner / analytics / Tantivy-planner corrections (`CQ-083..CQ-090`) are
  closed; `CQ-091` closed at `585a456` (SessionBlob projection-bridge
  UTF-8 byte accounting); `CQ-092` closed by this iteration's roadmap
  reconciliation commit.
- [ ] Final Codex review completed. *(Pending — Lane 3 remainder (Tantivy
  writer, DuckDB views, runtime Parquet merge) plus Lanes 4–10 still
  unstarted/incomplete.)*
- [ ] Five-cycle final stabilization evidence recorded. *(Pending; Lane 1
  must be accepted by Codex first.)*
