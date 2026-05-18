# rearch-2 Ralph Loop Status

Started: 2026-05-18T15:30:01-03:00
Repository: `/home/cain/workspace/code/c3-oss/prosa`
Branch: `feature/rearch`
Monitor: `/home/cain/workspace/c3-oss/prosa-rearch-2-ralph-loop-monitor.md`
Monitor interval: 5 minutes unless overridden
Completion signal: RALPH_DONE

## Current State

Status: in-progress (Lane 0 closed; Lane 1 partial advancing)
Current lane: Lane 1 - Local store (partial; this iteration adds shard-actor command vocabulary + beginEpoch/sealEpoch + closes CQ-016..CQ-019)
Current HEAD: `4f214b7` (this iteration adds one more commit; see Decisions for the closing hash)
No-change streak: 0
Ralph active: yes

## Lane Status

| Lane | Owner | Status | Commit(s) | Evidence |
| --- | --- | --- | --- | --- |
| 00 - Foundation | Ralph | complete | `cd845f2`, `e22ec27`, `b78b5ae`, `70b9df0`, (+this iteration's CQ-016..CQ-019 closeout) | `evidence/lane-00.md` |
| 01 - Local store | Ralph | partial | `4f214b7`, `2b5ad1b`, (+this iteration's pack-writer-pool commit) | `evidence/lane-01.md` |
| 02 - Importers | Ralph | blocked-on-lane-01 | | `evidence/lane-02.md` |
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
| | | | All CQ-001..CQ-019 closed; see `correction-queue.md` "Closed". |

## Latest Gates

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short --branch` | pass | `## feature/rearch...origin/feature/rearch`. |
| `pnpm i` | pass | `pnpm install --frozen-lockfile`-compatible; only pre-existing peer warnings (`@c3-oss/config-vitest` wants vitest ^3.1.1, repo on 2.1.9). |
| `pnpm build` | pass | 10/10 turbo tasks (includes `@c3-oss/prosa-bundle-v2`). |
| `just typecheck` | pass | 10/10 turbo tasks. |
| `just test-all` | pass | 10/10 turbo tasks. Test counts: 89 in `@c3-oss/prosa-types-v2`, 21 in `@c3-oss/prosa-wire-v2`, 58 in `@c3-oss/prosa-bundle-v2` (post pack-writer-pool). |
| `just lint-all` | pass | 10/10 turbo tasks. |
| `pnpm test:conformance` | pass | 15 tests; 13 entity leaves stable. |
| `pnpm audit --audit-level moderate` | classified pass | 7 dev-tooling-only vulnerabilities, pre-existing; classified in `gates.md`. |
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
