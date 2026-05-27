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

Lane 7 is accepted by Codex/governor on 2026-05-20. CQ-149 through CQ-154 are
closed. Do not reopen Lane 7 unless a fresh command proves a regression.

Current milestone: **Lane 8 Audit and GC hardening**. Focused governor review
opened these blocking CQs:

- CQ-155: GC must revalidate receipt grants and open staging rows after
  tombstone and before delete.
- CQ-156: audit/GC handlers must be wired into API startup/config.
- CQ-157: monthly audit must hash pack bytes with the same BLAKE3 digest used
  by upload/catalog rows.

After CQ-155 through CQ-157 are closed and Lane 8 is accepted, continue to
**Lane 9 Migration hardening**. Focused governor review opened these blocking
CQs:

- CQ-158: remote migration must not publish `remote_authority_v2` or archive
  active v1 receipts until the load-bearing Lane 6 read projections are usable.
- CQ-159: multi-store remote migration must write resolvable per-store
  authority and archive each real store's v1 receipts.
- CQ-160: migrate-tenant receipt provenance must be server-owned; callers must
  not be able to sign arbitrary `serverRegion` values into receipts.
- CQ-161: local bundle migration needs read-only source proof,
  crash-safe rename/recovery proof, and performance-gate evidence or explicit
  governor rescope.

Governor smoke evidence:

```text
rg -n "startCron|registerAuditCron|registerGcCron" apps/api/src apps/api/test/v2/cron
```

This found only module definitions/comments and test imports; no production
startup call is present under `apps/api/src/server.ts`.

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/cron/gc-lifecycle.test.ts test/v2/cron/gc-blocked-by-grant.test.ts test/v2/cron/gc-blocked-by-staging.test.ts
Test Files  5 passed (5)
Tests       9 passed (9)
```

These current tests pass, but they do not cover the new blockers. Do not claim
Lane 8 or Lane 9 acceptance until the open CQs are closed with code, tests, and
recorded command evidence. Do not close these blockers with docs-only commits.

Latest governor WIP review, 2026-05-21:

- CQ-155 still open: current WIP rechecks references before delete, but a race
  remains between the final recheck and `objectStore.delete`; add a regression
  that inserts a grant/authority during that window and proves no delete occurs.
- CQ-156 still open: production wiring exists, but API typecheck currently
  fails on a `ProsaApiConfig` fixture missing `cronEnabled`/`cronIntervalMs`;
  fixed-interval scheduler semantics also need proof or explicit rescope.
- CQ-157 appears covered by current WIP, pending commit and clean typecheck /
  Lane 8 gate batch.
- CQ-158 still open: remote migration must prove `POST /v2/migrate/tenant`
  followed by `/v2/reads/sessions/list` returns the migrated session; same-size
  corrupted raw bytes must fail closed before authority/archive.
- CQ-159 still open: current multi-store test fails with
  `non-canonical id "sess_codex_B"` and must prove public per-store authority
  resolution after fixture repair.
- CQ-160 appears covered by current WIP, pending commit and clean Lane 9 gates
  after Lane 8 acceptance.

Latest governor smoke update, 2026-05-21:

- Focused cron tests pass, but `pnpm --filter @c3-oss/prosa-api typecheck`
  still fails in `apps/api/test/storage.test.ts` because `cronEnabled` and
  `cronIntervalMs` are missing from a config fixture.
- Focused migrate API tests now pass, including `tenant-reads-e2e`,
  `tenant-multistore`, and `tenant-receipt-provenance`; keep Lane 9 blocked
  until Lane 8 is accepted and all gate batches are clean.
- CQ-161 is now actively touched but failing:
  `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/bundle-atomic-rename.test.ts`
  fails with `ReferenceError: recoverFromMigrationMarker is not defined`.

Final reviewer update, 2026-05-21:

- Do not accept Lane 8. CQ-155 still has the final recheck-to-delete race; add
  a regression that inserts grant/authority after the final recheck and before
  object deletion, and prove no delete occurs. CQ-156 still needs real cadence
  scheduling or an explicit governor-approved fixed-interval rescope.
- Do not accept Lane 9. CQ-161 still opens the v1 bundle through the mutable
  opener and can delete arbitrary existing `--new` paths; add true read-only or
  temp-copy behavior and marker-bound cleanup only. CQ-159 still needs public
  `/v2/stores/<store>/authority` assertions and a documented/tested per-store
  or tenant-wide receipt provenance model.

Governor validation after closure commits, 2026-05-21:

- Ralph committed `665efc9` and `e235d1e`, but CQ-161 is reopened because the
  focused local bundle migration gate fails:
  ```text
  pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/bundle-atomic-rename.test.ts test/v2/migrate/bundle-read-only-and-recovery.test.ts
  Test Files  1 failed | 1 passed (2)
  Tests       1 failed | 5 passed (6)
  bundle-read-only-and-recovery.test.ts:
  expected SyntaxError: Unexpected non-whitespace character after JSON
  to match object { stage: 'validate' }
  ```
- Treat CQ-161 as open and blocking. Convert source-bundle mutation/parsing
  failures in the post-snapshot validation path into the expected
  `MigrationError` with `stage: 'validate'`, preserve the v1 source, reject
  the swap, and rerun the exact focused command above.
- CQ-155 is also reopened and blocking. The GC staging guard checks
  `head_json.pack_digests`, but production promotion staging uses bundle-head
  `segments` plus `promotion_uploaded_pack`; add production-shaped staging
  coverage. The current final race test expects bytes to be deleted after a
  late grant, which contradicts the invariant. Add a race/replay regression
  where GC must skip delete or seal must fail before authority/grants.
- Latest CQ-155 WIP review: the current uncommitted code looks directionally
  correct (`promotion_uploaded_pack` guards and shared `remote_pack FOR UPDATE`
  locks), and focused cron/typecheck smokes pass. Do not close CQ-155 yet:
  add actual two-transaction interleaving tests where seal wins the lock and GC
  skips delete, and where GC wins and seal fails before any receipt, authority,
  or grant is visible. Also cover `promotion_uploaded_pack` post-tombstone and
  `delete_pending` reversion paths.
- Final validation after `b14ea4c`: keep CQ-155 open. The code still appears
  directionally correct, but no cron test calls `sealPromotion()` or proves a
  real two-transaction seal-vs-GC interleaving. `promotion_uploaded_pack`
  coverage is still partial: only initial tombstone blocking is proven.
- CQ-156 is reopened pending decision: either implement real cron semantics or
  ask the governor to explicitly accept per-process interval cadence, including
  the fact that `lastFiredMs` resets on restart. Safe default: reject rescope
  and implement real cron semantics.
- Final validation after `b14ea4c`: keep CQ-156 open unless the docs are
  narrowed. The current rescope docs overstate durable cadence gating;
  hourly/daily/weekly audit may do bounded duplicate work after process or
  fleet restarts.
- Final validation after `b14ea4c`: keep CQ-161 open. The code still opens the
  operator v1 bundle through mutable `openBundleV1(oldPath)`, raw-source
  snapshots compare only name/size, marker pre-archive replay is untested, and
  `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/` failed in
  read-only review with the mid-flight mutation test resolving instead of
  rejecting.
- Restart validation after the uncommitted CQ-155/CQ-156/CQ-161 work:
  CQ-161 is acceptable after temp-copy read-only proof, content-hashed raw
  source snapshots, marker-owned pre-archive cleanup, and clean
  `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/`.
  CQ-156 is acceptable under the narrower documented cadence rescope.
  CQ-155 remains open: the new interleaving tests model the seal side with
  inline SQL instead of invoking production `sealPromotion()`. Add actual
  `sealPromotion()` GC-wins rejection/rollback and seal-wins GC reversion
  regressions before claiming Lane 8 acceptance.
- Final production-path review: the new seal-wins `sealPromotion()` test is
  acceptable, but GC-wins remains open. The current GC-wins test deletes
  `remote_pack` before calling `sealPromotion()`, so the failure occurs during
  pre-transaction byte/catalog verification. Add a GC-wins test where
  `verifyLinkedPackBytes()` succeeds, a simulated committed GC catalog delete
  happens immediately before `sealPromotion()`'s transaction body, and
  production `sealPromotion()` rolls back after the in-transaction
  `remote_pack FOR UPDATE` check fails, leaving zero receipt, authority,
  search-generation, and grant rows visible.
- Final review after the inside-transaction rollback regression: CQ-155 is
  acceptable. The new production-path rollback test is a sufficient PGlite
  simulation for the load-bearing invariant: `verifyLinkedPackBytes()` runs,
  `remote_pack` is absent before production `sealPromotion()` reaches the
  in-transaction `FOR UPDATE`, and the seal callback rolls back receipt,
  authority, search-generation, and grant writes. Residual risk: this is not a
  real concurrent Postgres lock test, but it is acceptable for Lane 8.
- `RALPH_DONE` is invalid only if new open Lane 7-9 blockers appear, gates fail,
  evidence is stale, or the worktree is not committed/clean.

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
