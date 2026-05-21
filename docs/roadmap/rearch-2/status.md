# rearch-2 Current Status

Updated: 2026-05-21 after final-validation closure of CQ-155, CQ-156, CQ-161.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **accepted**.
- Lane 4 Server: **accepted** by Codex/governor on 2026-05-20.
- Lane 5 Sync protocol: **accepted** by Codex/governor on 2026-05-20.
- Lane 6 Read API: **accepted** by Codex/governor on 2026-05-20.
- Lane 7 CLI and MCP: **accepted** by Codex/governor on 2026-05-20.
  CQ-149 through CQ-154 closed (CQ-154 closed via the executable
  slice 11 smoke at `apps/cli/test/v2/read-sessions-e2e.test.ts` — 2 tests
  pass end-to-end through Fastify + PGlite). Baseline `pnpm build`,
  `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `git diff --check` passed
  after `91a9f96`.
- Lane 8 Audit and GC: **awaiting governor acceptance**. CQ-155, CQ-156, and
  CQ-157 closed. GC's catalog-delete tx and seal-promotion's grant insert
  both take `FOR UPDATE` on `remote_pack`, so a concurrent seal lands the
  grant before phase 3 and GC reverts the pack to `live` — no bytes are
  deleted. The staging guard now joins `promotion_uploaded_pack` so the
  production-shape staging linkage is honored. CQ-156 carries an explicit
  governor-recorded rescope (`evidence/lane-08.md`,
  `apps/api/src/cron/wire.ts`): the per-process `lastFiredMs` is an
  optimization on top of durable handler-level cadence gates.
- Lane 9 Migration: **awaiting governor acceptance**. CQ-158, CQ-159, CQ-160,
  CQ-161 closed. The bundle migration mutation regression tampers a
  raw_sources file (not the v1 manifest) so the v1 opener runs cleanly and
  the snapshot-reverify catches the mutation; full focused gate passes.
- Lane 10 Cutover: **not in the next Ralph loop**.

## Lane 6 Acceptance

Lane 6 is accepted. CQ-142 through CQ-148 are clean for Lane 6 scope, including
CQ-148: `tool-calls/list` now tuple-matches `tool_call_id`, `session_id`,
`store_id`, and `receipt_id` when joining latest tool results.

A final Codex intervention also closed the same wrong-tuple class in
`sessions/transcript`: transcript latest-result lookup now tuple-matches
`tool_call_id/session_id/store_id/receipt_id`, with a focused regression proving
a current-authority result from another session is ignored.

Final evidence:

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  72 passed | 2 skipped (74)
Tests       431 passed | 4 skipped (435)
```

Additional Lane 6 evidence:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/tool-calls-list.test.ts`
  passed: 10 tests, including wrong-session, wrong-receipt, wrong-store, and
  `errorsOnly` CQ-148 regressions.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/transcript-pagination.test.ts`
  passed: 7 tests, including the final wrong-session latest-result transcript
  regression.
- `pnpm typecheck` passed repo-wide: 13/13 packages.
- `pnpm lint` passed repo-wide: 13/13 packages.
- `git diff --check` passed.
- Read-only reviewer found no blocker for Lane 6 acceptance.

Stabilization cycles are optional for this roadmap phase when all CQs, gates,
and evidence are clean and no useful executor work remains.

## Current Milestone

Lane 7 is accepted. Lane 8 is blocked by CQ-155/CQ-156. Lane 9 is blocked by
reopened CQ-161 and cannot be accepted until Lane 8 is accepted and the local
bundle migration focused gate is clean.

1. Fix CQ-155 with production-shaped staging coverage and a race regression
   where GC cannot delete bytes that an in-flight seal can still publish.
2. Either implement true cron semantics for CQ-156 or request explicit governor
   acceptance of the per-process interval-cadence rescope.
3. Fix CQ-161 and rerun:
   `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/bundle-atomic-rename.test.ts test/v2/migrate/bundle-read-only-and-recovery.test.ts`.
4. Keep Lane 10 stopped. Lane 10 requires a cutover-specific governor decision
   after Lane 9 is accepted.

## Open Future Blockers

- CQ-124: full v1/v2 schema cutover remains Lane 10 scope.
- CQ-134: projection/search materialization remains blocked behind CQ-124 and
  is Lane 10 scope.

These blockers do not invalidate Lane 6 acceptance and should not block Lanes
7-9 unless fresh smoke-command evidence proves a direct dependency.

## References

- Source plan: `docs/rearch-2/`.
- Active Ralph prompt: `docs/roadmap/rearch-2/ralph-loop-prompt.md`.
- Active gates: `docs/roadmap/rearch-2/gates.md`.
- Active correction queue: `docs/roadmap/rearch-2/correction-queue.md`.
