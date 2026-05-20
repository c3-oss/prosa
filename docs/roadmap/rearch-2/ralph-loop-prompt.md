# Ralph Loop: rearch-2 Lanes 7-9

Continue `rearch-2` after accepted Lane 6 Read API closeout. The next Ralph
loop runs **Lane 7 CLI and MCP**, then **Lane 8 Audit and GC**, then **Lane 9
Migration** in sequence.

Do not start Lane 10 in this loop. Lane 10 production cutover requires a
separate governor decision after Lane 9 is accepted.

## Read First

- `AGENTS.md`
- `.codex/skills/prosa-dev-workflow/SKILL.md`
- `.codex/skills/prosa-server-sync/SKILL.md`
- `.codex/skills/prosa-search-export/SKILL.md`
- `docs/rearch-2/00-README.md`
- `docs/rearch-2/08-lane-7-cli-and-mcp.md`
- `docs/rearch-2/09-lane-8-audit-and-gc.md`
- `docs/rearch-2/10-lane-9-migration.md`
- `docs/roadmap/rearch-2/status.md`
- `docs/roadmap/rearch-2/gates.md`
- `docs/roadmap/rearch-2/correction-queue.md`
- `docs/roadmap/rearch-2/evidence/lane-07.md`
- `docs/roadmap/rearch-2/evidence/lane-08.md`
- `docs/roadmap/rearch-2/evidence/lane-09.md`

## Current State

Lanes 0-6 are accepted. Lane 6 final API evidence:

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  72 passed | 2 skipped (74)
Tests       431 passed | 4 skipped (435)
```

CQ-124 and CQ-134 remain Lane 10-only deferred blockers. Do not reopen them for
Lanes 7-9 unless a fresh direct smoke command proves they block the current
milestone.

Final Lane 6 follow-up is already closed: both `tool-calls/list` and
`sessions/transcript` latest-result lookups tuple-match
`tool_call_id/session_id/store_id/receipt_id`.

## Milestone Order

### Lane 7 — CLI and MCP

Core milestone work:

- `prosa read *` command group consumes the Lane 6 read API.
- CLI authority cache supports 60 s TTL, `--refresh`, `--offline`, and 412
  handling.
- `prosa mcp serve --authority {auto|local|remote}` pins authority and exposes
  `prosa.refresh_authority`.
- Web data layer consumes `/v2/reads/*` while preserving existing route shapes.

Required support work:

- Shared typed client helpers, auth/config plumbing, fixtures, and focused CLI,
  MCP, or web tests needed to prove Lane 7.
- Documentation of the v1-to-v2 command mapping.

Premature/later-lane work:

- Audit/GC cron behavior, migration tooling, production cutover, broad
  dashboards, or schema cutover unless required by a smoke-proven Lane 7
  blocker.

### Lane 8 — Audit and GC

Start only after Lane 7 gates are clean and recorded.

Core milestone work:

- Audit cron handlers for hourly, daily, weekly, and monthly cadences under
  advisory locks.
- Missing/mismatched pack drift detection, pack quarantine, receipt degradation,
  and authority `repair` surface.
- `artifacts.getText` 503 fallback for quarantined pack bytes.
- GC lifecycle for unreferenced packs with tombstone and delete phases.
- Metrics for audit findings and GC volume/failures.

Required support work:

- Schema additions needed for receipt audit state.
- Object-store test doubles and cron runner helpers needed for deterministic
  evidence.

Premature/later-lane work:

- Migration or cutover behavior unless needed to prove Lane 8.

### Lane 9 — Migration

Start only after Lane 8 gates are clean and recorded.

Core milestone work:

- `prosa migrate-v2 bundle` local migration from v1 preserved raw bytes.
- Count validation and abort-before-rename safety.
- Progress reporting and JSON output.
- Provider-history fallback for corrupted or missing raw bytes.
- `prosa migrate-v2 tenant` / `POST /v2/migrate/tenant` remote re-projection.
- `legacy_receipt_archive` for v1 receipt audit history.

Required support work:

- Fixture bundles, migration temp-path helpers, remote migration test harnesses,
  and docs/runbooks needed to prove Lane 9.

Premature/later-lane work:

- Lane 10 production flag flip, customer communications, v1 deletion, or
  production cutover runbooks beyond the minimal Lane 9 migration policy docs.

## Correction Queue Rules

Use `docs/roadmap/rearch-2/correction-queue.md`.

Add a CQ immediately for any blocker that can break product behavior, security,
data integrity, parity, or release gates. A CQ must include concrete acceptance
criteria and command evidence. Environment, dependency, or service blockers are
not accepted without a direct smoke command and recorded output.

If a blocker requires a Codex/governor architecture decision, ask one explicit
binary question with a safe default. Do not spin on vague "external acceptance".

## Evidence Rules

Record evidence in the active lane file:

- Lane 7: `docs/roadmap/rearch-2/evidence/lane-07.md`
- Lane 8: `docs/roadmap/rearch-2/evidence/lane-08.md`
- Lane 9: `docs/roadmap/rearch-2/evidence/lane-09.md`

Batch routine status/hash pins per coherent slice. Record immediate evidence
only when closing a CQ or proving a blocker.

## Gate Rules

Use `docs/roadmap/rearch-2/gates.md`. A lane is accepted only when its gate
checklist, focused tests, baseline checks, and evidence are clean.

Required baseline before each lane acceptance claim:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm lint
git diff --check
```

Focused gates may run first for faster iteration, but do not claim lane
completion without recording the lane's focused evidence and the baseline batch.

## Completion Contract

`RALPH_DONE` is valid only when:

- Lane 7, Lane 8, and Lane 9 are all complete.
- `gates.md` has clean checkboxes for Lanes 7-9.
- `correction-queue.md` has no open blockers for Lanes 7-9.
- Evidence files for Lanes 7-9 contain command output for focused and baseline
  gates.
- The worktree is clean or all WIP is explicitly documented.
- Lane 10 has not been started.

Final stabilization is optional when no useful Ralph work remains. If all gates,
CQs, and evidence are clean, stop for Codex/governor acceptance instead of
running no-op cycles.
