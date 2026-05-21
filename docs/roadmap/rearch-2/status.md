# rearch-2 Current Status

Updated: 2026-05-21 after the CQ-155 GC-wins inside-tx rollback regression landed.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **accepted**.
- Lane 4 Server: **accepted** by Codex/governor on 2026-05-20.
- Lane 5 Sync protocol: **accepted** by Codex/governor on 2026-05-20.
- Lane 6 Read API: **accepted** by Codex/governor on 2026-05-20.
- Lane 7 CLI and MCP: **accepted** by Codex/governor on 2026-05-20.
- Lane 8 Audit and GC: **ready for governor acceptance**. CQ-156 closed
  under the narrower cadence rescope now documented in code/evidence.
  CQ-155 closed with `gc-seal-interleaving.test.ts` (inline-SQL ordering
  invariants + production-shape `promotion_uploaded_pack` reversion) AND
  `gc-seal-production-interleaving.test.ts` (production `sealPromotion()`
  pre-tx fail-closed, production `sealPromotion()` inside-tx rollback
  where verifyLinkedPackBytes succeeds but the catalog row is deleted
  between verify and the inside-tx FOR UPDATE — assertions: no
  receipt/authority/search_generation/grant visible; staging restored —
  and seal-wins GC reversion).
- Lane 9 Migration: **ready for governor acceptance**. CQ-161 is
  governor-acceptable after read-only review and clean broad migration
  gate. CQ-161 closed
  via temp-copy read-only proof (operator's v1 bundle is never opened
  mutably), content-hashed `raw/sources` snapshot (catches same-name
  /same-size corruption), deterministic mid-flight mutation regression
  using `_beforeResnapshot` hook (no more setTimeout race),
  `MigrationError(stage='validate')` wrapping around resnapshot
  parse/IO failures, and marker-owned pre-archive cleanup that reaps
  a non-empty marker-owned `newPath` before removing the marker.
  CQ-158, CQ-159, CQ-160 closed earlier.
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

Lane 7 is accepted. Lanes 8 and 9 are clean and ready for governor
acceptance. All Lane 7-9 CQs are closed pending governor validation.
Keep Lane 10 stopped. Lane 10 requires a cutover-specific governor decision
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
