# rearch-2 Ralph Loop Status

Started: 2026-05-18T15:30:01-03:00
Repository: `/home/cain/workspace/code/c3-oss/prosa`
Branch: `feature/rearch`
Monitor: `/home/cain/workspace/c3-oss/prosa-rearch-2-ralph-loop-monitor.md`
Monitor interval: 5 minutes unless overridden
Completion signal: RALPH_DONE

## Current State

Status: in-progress (correction required after Codex review)
Current lane: corrections before further Lane 1 / any Lane 2 work
Current HEAD: `aecc9af`
No-change streak: 2 (last code-touching commit was `f54f4f1`; `f3730b3` and this iteration's commit are docs-only governance refreshes)
Ralph active: yes

## Lane Status

| Lane | Owner | Status | Commit(s) | Evidence |
| --- | --- | --- | --- | --- |
| 00 - Foundation | Ralph | awaiting-codex-acceptance | `cd845f2`, `e22ec27`, `b78b5ae`, `70b9df0`, `0e8a912`, `a650ef8`, `2809d21` (Lane 0 CQ-001..CQ-019 closed; later commits also touch `CANONICAL.md` governance) | `evidence/lane-00.md` |
| 01 - Local store | Ralph | awaiting-codex-acceptance | `4f214b7`, `2b5ad1b`, `433c32f`, `a650ef8`, `6097f9e`, `5a6a683`, `2809d21`, `5e5ca20`, `ea615dd`, `5e4b5e7`, `ecc80a3`, `1419d92`, `1e81888`, `adee042`, `f54f4f1`, `f3730b3`, `aecc9af`, plus pending CQ-060..CQ-062 commit | `evidence/lane-01.md` |
| 02 - Importers | Ralph | blocked-on-lane-01 | `004107c` (out-of-sequence WIP, unaccepted) | `evidence/lane-02.md` |
| 03 - Derived layer | Ralph | blocked-on-lane-02 | | `evidence/lane-03.md` |
| 04 - Server | Ralph | blocked-on-lane-00 | | `evidence/lane-04.md` |
| 05 - Sync protocol | Ralph | blocked-on-lane-04 | | `evidence/lane-05.md` |
| 06 - Read API | Ralph | blocked-on-lane-05 | | `evidence/lane-06.md` |
| 07 - CLI and MCP | Ralph | blocked-on-lane-06 | | `evidence/lane-07.md` |
| 08 - Audit and GC | Ralph | blocked-on-lane-05 | | `evidence/lane-08.md` |
| 09 - Migration | Ralph | blocked-on-lane-05 | | `evidence/lane-09.md` |
| 10 - Cutover | Ralph | blocked-on-lane-09 | | `evidence/lane-10.md` |

## Open Blocking Corrections

| ID | Severity | Owner | Summary |
| --- | --- | --- | --- |
| CQ-044 | high | Ralph | Contain out-of-sequence Lane 2+ work until Lane 1 acceptance. |

CQ-036..CQ-043 closed at `5e5ca20`. CQ-045..CQ-049 closed at
`ea615dd`. CQ-050..CQ-055 closed by `5e4b5e7` / `ecc80a3` /
`1419d92` / `1e81888`. Lane 0 evidence refreshed in `adee042`.
CQ-056..CQ-059 closed by `f54f4f1` / `f3730b3` / `aecc9af`.
CQ-060..CQ-062 closed in the pending closeout commit (non-head
epoch authority via previousBundleRoot chain, install-failure
rollback, governance reconcile). `CQ-044` remains open until Lane 1
is accepted by Codex.

## Latest Gates

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short --branch` | pass | `## feature/rearch...origin/feature/rearch`. |
| `pnpm i` | pass | `pnpm install --frozen-lockfile`-compatible; only pre-existing peer warnings (`@c3-oss/config-vitest` wants vitest ^3.1.1, repo on 2.1.9). |
| `pnpm build` | pass | 10/10 turbo tasks (includes `@c3-oss/prosa-bundle-v2`). |
| `just typecheck` | pass | 10/10 turbo tasks. |
| `just test-all` | pass | 12/12 turbo (`pnpm test` proxy). Focused counts after CQ-063: types-v2 89, wire-v2 21, conformance 15, bundle-v2 **114** (+CQ-060 lockstep-tamper x1, +CQ-061 install-rename-fault x1, +CQ-063 rollback-also-fails x1), importers-v2 8, db-v2 6. |
| `just lint-all` | pass | 10/10 turbo tasks. |
| `pnpm test:conformance` | pass | 15 tests; 13 entity leaves stable. |
| `pnpm audit --audit-level moderate` | classified pass | 8 findings (1 low / 6 moderate / 1 high), all pre-existing on `master`; only `apps__cli>ink>ws` touches a non-dev path. Classified in `gates.md`. |
| `git diff --check` | pass | No whitespace or conflict markers. |

## Decisions

- 2026-05-18T15:30:01-03:00: Use `docs/rearch-2/` as the source of truth for
  lane contracts and `docs/roadmap/rearch-2/` for active Ralph Loop artifacts.
- 2026-05-18T15:30:01-03:00: Treat the run as sequential by lane, with open
  blocking corrections taking precedence over new implementation work.
- 2026-05-18T15:30:01-03:00: Require final five-cycle stabilization before
  accepting `RALPH_DONE`.
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
