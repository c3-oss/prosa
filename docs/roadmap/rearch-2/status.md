# rearch-2 Ralph Loop Status

Started: 2026-05-18T15:30:01-03:00
Repository: `/home/cain/workspace/code/c3-oss/prosa`
Branch: `feature/rearch`
Monitor: `/home/cain/workspace/c3-oss/prosa-rearch-2-ralph-loop-monitor.md`
Monitor interval: 5 minutes unless overridden
Completion signal: RALPH_DONE

## Current State

Status: Lane 1 accepted; Lane 2 accepted by Codex/governor on 2026-05-19; Lane 3 progress: scaffold (`bb76006`), SessionBlobPackV2 byte layout (`ba87f05`), Parquet compaction planner (`ea8c1a8`), DuckDB analytics view shape contract (`cff3670`), CQ-089 compacted-overlay fix (`e35f844`), Tantivy schema + rebuild planner (`509e1f1`), CAS-ref UTF-8 byte accounting (`585a456`), SessionBlob cross-page transcript iterator (`c7e027d`), Tantivy IndexCheckpointV2 persistence (`9ebbd07`), CQ-093 atomic checkpoint replacement (`734b958`), analytics execution-plan composer (`3f54ca6`), Tantivy index-dir probe (`8d45fbb`), CQ-094 symlink rejection (`2c97eca`), `planTantivyRebuildFromBundle` orchestration (`fa49eb2`), CQ-095 roadmap reconciliation (`e1e432d`), compaction execution-plan composer (`87bacb0`), `derivedPaths` centralised layout (`d3811b4`), `clearTantivyIndexDir` reset helper (`257a176`), prompt hash pin (`3b9f79e`), CQ-096 intermediate symlink containment (`3be300f`), CQ-096 prompt/status pin (`0b3dfd0`), SessionBlob pack-path resolver + CQ-097 textual-source cleanup (`d798b15`), prompt/status pin (`2d273c2`), `loadSessionBlobPack` loader (`eb88037`), CQ-098 intermediate symlink containment (`ea5f5d1`), production zstd codec (`62550e1`), SessionBlob listing helpers + containment refactor + CQ-099 resolver-parity (`f8a2b7a`), prompt/status pin (`b4c66bd`), `loadLatestSessionBlobPack` latest-epoch loader (`f0a6ba7`), `loadTranscriptFromBundle` end-to-end loader + CQ-100 input-validation-before-listing (`d9dfc19`), prompt/status pin (`832d98b`), `iterateTranscriptFromBundle` streaming counterpart (`c1a2836`), prompt/status pin (`f3fc4c2`), `listAllSessionBlobSessions` cross-epoch union (`b5ea97c`), prompt/status pin (`bed6dab`), `readSessionBlobHeader` header-only reader (`2c993ae`), prompt/status pin (`e284fc9`), `sessionBlobPackExists` cheap probe (`9dc147b`), prompt/status pin (`22b5b9b`), `latestEpochForSession` epoch-only lookup (`85931e2`), prompt/status pin (`4a26120`), `getSessionBlobSummary` aggregate inventory row (`21ce057`), prompt/status pin (`59587e0`), `listSessionBlobSummaries` bulk inventory listing (`d8e1e5c`), prompt/status pin (`06b1f81`), `tantivyIndexStatus` read-only status snapshot (`584029d`), prompt/status pin (`40458f8`), `analyticsViewsDescriptor` catalog packager (`09ca11e`), prompt/status pin (`8d1f76c`), `bundleDerivedStatus` top-level aggregator (`1cf6c95`), prompt/status pin (`7aa8fe7`), `listProjectionSegments` Parquet segment listing (`50c901e`), prompt/status pin (`8f7a889`), `summariseProjectionSegments` rollup (`15a975a`), prompt/status pin (`3862b17`), SessionBlob read-side end-to-end integration test (`aac58e9`), prompt/status pin (`39cdd74`), compaction read-side end-to-end integration test (`447f60c`), prompt/status pin (`d67bd6c`), Tantivy read-side end-to-end integration test (`784c1e0`), projection-segments preemptive containment hardening + CQ-101 planner-refactor closeout (`668f473`).
Current lane: Lane 3 — remaining surfaces are the Tantivy native writer (needs `@oxdev03/node-tantivy-binding` workspace allowlist) and the DuckDB / Parquet runtime executors.
Current HEAD: `668f473` (projection-segments containment + CQ-101 planner refactor).
No-change streak: 0
Ralph active: yes

## Lane Status

| Lane | Owner | Status | Commit(s) | Evidence |
| --- | --- | --- | --- | --- |
| 00 - Foundation | Ralph | accepted | `cd845f2`, `e22ec27`, `b78b5ae`, `70b9df0`, `0e8a912`, `a650ef8`, `2809d21` (Lane 0 CQ-001..CQ-019 closed; later commits also touch `CANONICAL.md` governance) | `evidence/lane-00.md` |
| 01 - Local store | Ralph | accepted (with re-scopes per `docs/rearch-2/lane-1-rescopes.md`) | `4f214b7`, `2b5ad1b`, `433c32f`, `a650ef8`, `6097f9e`, `5a6a683`, `2809d21`, `5e5ca20`, `ea615dd`, `5e4b5e7`, `ecc80a3`, `1419d92`, `1e81888`, `adee042`, `f54f4f1`, `f3730b3`, `aecc9af`, `b970437`, `6c25966`, `fc86533`, `a187a74`, `4792457` | `evidence/lane-01.md` |
| 02 - Importers | Ralph | accepted by Codex/governor on 2026-05-19; full provider implementation landed; CQ-082 closeout committed at `3eb1c08`; no remaining Lane 2 acceptance gate | `004107c`, `fc66925`, `8c0ba5f`, `aa88079`, `c496bac`, `8247a4c`, `58cca83`, `d302bc6`, `7eaed27`, `b660f44`, `8c1714f`, `af27eba`, `7a06c89`, `15194b5`, `3eb1c08` | `evidence/lane-02.md` |
| 03 - Derived layer | Ralph | scaffold + SessionBlobPackV2 byte layout + Parquet compaction planner + DuckDB analytics view shape contract + Tantivy schema/rebuild-planner + SessionBlob projection-bridge with UTF-8 byte accounting + cross-page transcript iterator + Tantivy IndexCheckpointV2 persistence with atomic replacement + analytics execution-plan composer + Tantivy index-dir probe with CQ-094 final-component + CQ-096 intermediate symlink rejection + `planTantivyRebuildFromBundle` orchestration + compaction execution-plan composer + `derivedPaths` centralised layout + `clearTantivyIndexDir` reset helper + SessionBlob pack-path resolver + `loadSessionBlobPack` loader with CQ-098 intermediate symlink containment + production zstd codec + SessionBlob listing helpers with CQ-099 resolver-parity + shared containment helper + `loadLatestSessionBlobPack` latest-epoch loader with CQ-100 input-validation-before-listing + `loadTranscriptFromBundle` end-to-end loader + `iterateTranscriptFromBundle` streaming counterpart + `listAllSessionBlobSessions` cross-epoch union + `readSessionBlobHeader` header-only reader + `sessionBlobPackExists` cheap probe + `latestEpochForSession` epoch-only lookup + `getSessionBlobSummary` aggregate inventory row + `listSessionBlobSummaries` bulk inventory listing + `tantivyIndexStatus` read-only status snapshot + `analyticsViewsDescriptor` catalog packager + `bundleDerivedStatus` top-level aggregator + `listProjectionSegments` Parquet segment listing + `summariseProjectionSegments` rollup + SessionBlob read-side end-to-end integration test + compaction read-side end-to-end integration test + Tantivy read-side end-to-end integration test + projection-segments containment hardening + CQ-101 planner refactor landed; Tantivy native writer + DuckDB/Parquet runtime executors pending | `bb76006`, `ba87f05`, `ea8c1a8`, `76128fa`, `16985b4`, `cff3670`, `e35f844`, `509e1f1`, `585a456`, `c7e027d`, `9ebbd07`, `734b958`, `3f54ca6`, `8d45fbb`, `2c97eca`, `fa49eb2`, `e1e432d`, `87bacb0`, `d3811b4`, `257a176`, `3b9f79e`, `3be300f`, `0b3dfd0`, `d798b15`, `2d273c2`, `eb88037`, `ea5f5d1`, `ca89378`, `62550e1`, `f8a2b7a`, `b4c66bd`, `f0a6ba7`, `79e47f7`, `d9dfc19`, `832d98b`, `c1a2836`, `f3fc4c2`, `b5ea97c`, `bed6dab`, `2c993ae`, `e284fc9`, `9dc147b`, `22b5b9b`, `85931e2`, `4a26120`, `21ce057`, `59587e0`, `d8e1e5c`, `06b1f81`, `584029d`, `40458f8`, `09ca11e`, `8d1f76c`, `1cf6c95`, `7aa8fe7`, `50c901e`, `8f7a889`, `15a975a`, `3862b17`, `aac58e9`, `39cdd74`, `447f60c`, `d67bd6c`, `784c1e0`, `8548498`, `441d89b`, `668f473` | `evidence/lane-03.md` |
| 04 - Server | Ralph | scaffold-landed | `5e5ca20` (`packages/prosa-db-v2/` Postgres DDL + pglite tests) | `evidence/lane-04.md` |
| 05 - Sync protocol | Ralph | blocked-on-lane-04 | | `evidence/lane-05.md` |
| 06 - Read API | Ralph | blocked-on-lane-05 | | `evidence/lane-06.md` |
| 07 - CLI and MCP | Ralph | blocked-on-lane-06 | | `evidence/lane-07.md` |
| 08 - Audit and GC | Ralph | blocked-on-lane-05 | | `evidence/lane-08.md` |
| 09 - Migration | Ralph | blocked-on-lane-05 | | `evidence/lane-09.md` |
| 10 - Cutover | Ralph | blocked-on-lane-09 | | `evidence/lane-10.md` |

## Open Blocking Corrections

(none — `CQ-091`..`CQ-101` are all closed.)

## Latest Gates

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short --branch` | pass | `## feature/rearch...origin/feature/rearch [ahead 6]` at `aa88079`; Codex steering opened `CQ-070` after this check. |
| `pnpm i` | pass | `pnpm install --frozen-lockfile`-compatible; only pre-existing peer warnings (`@c3-oss/config-vitest` wants vitest ^3.1.1, repo on 2.1.9). |
| `pnpm build` | pass | 10/10 turbo tasks (includes `@c3-oss/prosa-bundle-v2`). |
| `just typecheck` | pass | 10/10 turbo tasks. |
| `just test-all` | pass | 12/12 turbo (`pnpm test` proxy) per Ralph panel after `aa88079`; focused counts verified by Codex after `aa88079`: types-v2 89, wire-v2 21, conformance 15, bundle-v2 **120**, importers-v2 **24**, db-v2 6. |
| `just lint-all` | pass | 10/10 turbo tasks. |
| `pnpm test:conformance` | pass | 15 tests; 13 entity leaves stable. |
| `pnpm audit --audit-level moderate` | classified pass | 8 findings (1 low / 6 moderate / 1 high), all pre-existing on `master`; only `apps__cli>ink>ws` touches a non-dev path. Classified in `gates.md`. |
| `git diff --check` | pass | No whitespace or conflict markers. |

## Decisions

- 2026-05-19 (Codex steering): `CQ-083` supersedes the earlier Lane 3 start
  assumption until the Lane 2 closeout is committed without tracked Lane 3
  changes. Lane 3 scaffold work may remain unaccepted WIP, but must not be
  included in the Lane 2 closeout commit or counted as accepted progress.
- 2026-05-19 (Codex/governor acceptance): Lane 2 is accepted. The importer
  lane has all provider implementations, fixture corpora, projection-id
  idempotency, bundle-compile idempotency, CLI help smokes, and focused gates
  recorded; no remaining "external acceptance" gate blocks Lane 3 progress.
- 2026-05-18T15:30:01-03:00: Use `docs/rearch-2/` as the source of truth for
  lane contracts and `docs/roadmap/rearch-2/` for active Ralph Loop artifacts.
- 2026-05-18T15:30:01-03:00: Treat the run as sequential by lane, with open
  blocking corrections taking precedence over new implementation work.
- 2026-05-18T15:30:01-03:00: Require final five-cycle stabilization before
  accepting `RALPH_DONE`.
- 2026-05-18T21:32:12-03:00: `CQ-067` blocks Lane 2 acceptance and
  `RALPH_DONE`, but must not create an empty-loop external-acceptance stall.
  Ralph should reconcile the artifacts while continuing non-conflicting Lane 2
  provider work.
- 2026-05-18T21:44:34-03:00: `CQ-068` blocks Claude provider acceptance,
  Lane 2 acceptance, and `RALPH_DONE`, but does not block independent
  Cursor/Gemini/Hermes provider work.
- 2026-05-18T21:47:33-03:00: `CQ-069` records current Cursor WIP typecheck
  failures; it blocks Cursor provider acceptance, Lane 2 acceptance, and
  `RALPH_DONE`, but does not block independent Gemini/Hermes work.
- 2026-05-18T22:30:41-03:00: `CQ-072` records premature `CQ-071` closeout:
  the CLI WIP is still uncommitted and missing `--help` smokes. It blocks
  Lane 2 CLI acceptance, Lane 2 acceptance, Lane 3 start, and `RALPH_DONE`,
  but does not block implementing the listed CLI test/evidence fixes.
- 2026-05-18 (user direction): Lane 1 must be completely complete against
  `docs/rearch-2/02-lane-1-local-store.md`; no partial/code closeout is
  accepted, and Lane 2+ remains blocked until `CQ-065`, `CQ-064`, and `CQ-044`
  close with evidence.
- 2026-05-18T15:34:46-03:00: Created Vikunja project `Prosa` (id 4) and task
  `Run Ralph Loop for Prosa rearch-2` (id 45) for the kickoff action.
- 2026-05-18T15:42:30-03:00: Active check 2 found new untracked
  `packages/prosa-types-v2/` Lane 0 implementation files. Started read-only
  Lane 0 reviews with `prosa-architect` and
  `ralph-loop-promotion-integrity-reviewer`.
- 2026-05-18T15:48:37-03:00: Lane 0 reviewers returned blocking findings.
  Converted them into `CQ-001` through `CQ-008`.
- 2026-05-18T16:02:03-03:00: Codex re-reviewed Lane 0; CQ-009 added for CI
  coverage.
- 2026-05-18T16:09:47-03:00: Codex validation noted `prosa-wire-v2` tests
  failing on `manifestDigest` fixtures during transient state; that fixture
  was using a non-hex character. Resolved in this iteration along with the
  full CQ-001…CQ-009 closeout.
- 2026-05-18 (this iteration, late): Ralph closed CQ-001 through CQ-009.
  Concrete artifacts:
  - `BundleHeadV2` gained `manifestDigest`; `bundleRoot` pinned as
    cross-entity projection root (CQ-001).
  - `merkleLeaf` rejects non-canonical timestamp / id / hash fields via
    new `validateFieldValue()` + per-entity `ENTITY_FIELD_KINDS` map
    (CQ-002).
  - `rawSourceLeaf()` / `rawSourceRootFromEntries()` implemented with
    pinned domain separator `prosa.rawsource.leaf.v2`; spec in
    `CANONICAL.md` rule 11 (CQ-003).
  - Named hash kinds (`ObjectId`, `StoredHash`, `PackDigest`,
    `ObjectSetRoot`, etc.) documented + Zod-aliased (CQ-004).
  - `receiptPayloadBytes()` + `deriveReceiptId()` implemented with pinned
    nested-object ordering (CQ-005).
  - `RawRecordV2` extended with locator fields; `deriveSourceFileId()` and
    `deriveRawRecordId()` exported with pinned derivation (CQ-006).
  - `.github/workflows/ci.yml` added wiring `pnpm i / build / typecheck /
    test / lint / test:conformance / audit / git diff --check` on push and
    PR (CQ-009).
  - Final test counts: `prosa-types-v2` 75 across 8 files;
    `prosa-wire-v2` 14; root conformance 15.
- 2026-05-18 (this iteration): `mtime_ns` in source-file fixture remains
  `null` because raw nanoseconds overflow `Number.MAX_SAFE_INTEGER`; Lane 1
  must adopt `bigint | null` once filesystem stats are read.
- 2026-05-18 (this iteration): Lane 0 conformance test runs from the
  workspace root via `vitest.config.ts` + `pnpm test:conformance`; CI hits
  the same target.
- 2026-05-18T16:20:36-03:00: Final Lane 0 reviewers found remaining blockers
  after `cd845f2`/`e22ec27`. Opened `CQ-010` through `CQ-015`; Lane 1 must stay
  blocked until these are closed with code, tests, and consistent evidence.
- 2026-05-18T16:47:42-03:00: Final Lane 0 reviewers found remaining blockers
  after `b78b5ae`/`70b9df0` and while `4f214b7` Lane 1 partial exists. Opened
  `CQ-016` through `CQ-019`; Lane 0 remains in correction and Lane 1 remains
  blocked.
- 2026-05-18T16:58:34-03:00: Ralph committed `0e8a912` for `CQ-016` through
  `CQ-019` and `2b5ad1b` for Lane 1 shard actors / epoch lifecycle. Focused
  gates passed: `prosa-types-v2` 89 tests, `prosa-wire-v2` 21 tests,
  conformance 15 tests, `prosa-bundle-v2` 46 tests, and `git diff --check`.
- 2026-05-18T17:04:00-03:00: Codex reviewers found new blocking corrections.
  `CQ-020` through `CQ-022` block Lane 0 acceptance because durable contract
  and evidence artifacts are stale or contradictory. `CQ-023` through `CQ-028`
  block further Lane 1 reliance because `sealEpoch`, FK/object closure,
  crash-safety, pack digest verification, zstd verification, and Lane 1
  evidence are not yet safe enough for downstream lanes.
- 2026-05-18T17:05:00-03:00: Ralph also committed `433c32f` for CAS/raw-source
  pack writer pools and `1ae4185` for gitignore of session-local state while
  Codex was writing the correction queue. These commits are not yet accepted;
  the open correction queue remains the priority before any Lane 2 work.
- 2026-05-18T17:15:49-03:00: Ralph committed `a650ef8` claiming closure of
  `CQ-020` through `CQ-028`, then `6097f9e` for projection segment writer and
  synthetic seal E2E. Focused gates before `6097f9e` passed for types-v2,
  wire-v2, conformance, and bundle-v2. Codex reviewer follow-up found
  remaining blockers: stale status/evidence, stale Lane 0 canonical-rule
  excerpt, unverifiable durable refs in `sealEpoch`, bypassable object
  inventory, incomplete FK closure, incomplete fsync durability, and
  non-canonical pack header acceptance. Opened `CQ-029` through `CQ-035`;
  Lane 2 remains blocked.
- 2026-05-18T17:49:05-03:00: Ralph committed `2809d21` claiming closure of
  `CQ-029` through `CQ-035`. Focused gates passed: types-v2 89,
  wire-v2 21, conformance 15, bundle-v2 86, bundle-v2 typecheck/lint, and
  `git diff --check`. Codex reviewers found `CQ-029` still stale and
  remaining Lane 1 integrity blockers: raw-source pack/source-row mismatch
  risk, insufficient kind-specific/realpath durable-ref containment, missing
  registered-ref parent directory fsync, CAS object count drift,
  incomplete `search_doc` FK closure, missing non-canonical header tests, and
  cold rebuild durability/verification gaps. Opened `CQ-036` through `CQ-043`;
  Lane 2 remains blocked. `packages/prosa-importers-v2/` appeared untracked
  and is not accepted.
- 2026-05-18T18:01:27-03:00: Active check found new commit `004107c`
  (`feat(core): begin lane 2 — importer contract, GraphResolver,
  orchestrator`) plus untracked `packages/prosa-db-v2/` and lockfile changes
  while `CQ-036` through `CQ-043` remain open. Opened `CQ-044` to contain
  out-of-sequence Lane 2+ work and keep it out of acceptance until Lane 1
  passes Codex re-review.
- 2026-05-18 (this iteration): Applied CQ-036..CQ-043 fixes in the working
  tree against HEAD `004107c`:
  - CQ-037: `sealEpoch` now builds a verified raw-source inventory from
    `raw_source_pack` refs and enforces per-source_file_id equivalence
    against staged `source_file` rows (`content_hash`, `object_id`,
    `size_bytes`, `pack_digest`, `stored_offset`, `stored_length`,
    `compression`). Duplicate `source_file_id` across packs and orphaned
    pack entries are rejected.
  - CQ-038: lifecycle adds `lstat`-based symlink rejection, `realpath`
    bundle-root containment, and a kind-specific containment check
    (`enforceKindContainment`) pinning projection refs under the epoch
    tmp/permanent `projection/` dir, CAS refs under `cas/packs`/`cas/large`,
    raw-source refs under `raw_sources/packs`, and manifest refs under
    the epoch tmp/permanent dirs.
  - CQ-039: `sealEpoch` fsyncs every unique parent directory of registered
    refs before the epoch-dir rename.
  - CQ-040: `counts.objects` is now the verified CAS inventory size only,
    decoupled from raw-source entry count.
  - CQ-041: `FK_RULES` extended with `search_doc.session_id → session` and
    `search_doc.project_id → project`.
  - CQ-042: added canonical-header rejection tests for both CAS and
    raw-source packs (reordered keys + extra whitespace, with recomputed
    `header_blake3`).
  - CQ-043: `rebuildIndex` now loads the signed epoch manifest, verifies
    each projection segment's `blake3(file)` matches the declared digest
    (`RebuildIntegrityError`), uses `writeFileDurable`/`syncDir` for
    shard logs and `rebuild.manifest`, and fsyncs the parent dir after
    both the archive rename and the install rename.
  - Bundle-v2 focused gates: typecheck pass, **91/91 tests** pass
    (added 3 tests across cas-pack, raw-source-pack, rebuild).
  - CQ-036: governance reconciled in this entry; will be marked closed
    when the commit lands.
