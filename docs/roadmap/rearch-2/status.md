# rearch-2 Current Status

Updated: 2026-05-20 after Codex/governor Lane 8/9 review blockers.

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
- Lane 8 Audit and GC: **blocked by CQ-155 through CQ-157** after focused
  governor review. Do not accept until GC revalidates references before delete,
  audit/GC are wired into API startup, and monthly audit uses the same BLAKE3
  digest as pack upload.
- Lane 9 Migration: **blocked by CQ-158 through CQ-161** after focused
  governor review. Do not accept until remote migration publishes authority only
  after load-bearing projections are usable, multi-store migration resolves
  authority and archives every real store, receipt provenance is server-owned,
  and local migration read-only/crash-safety/performance evidence is clean.
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

Lane 7 is accepted. The active milestone returns to **Lane 8 Audit and GC
hardening**:

1. Close CQ-155, CQ-156, and CQ-157 with code and smoke-command evidence.
2. Only after Lane 8 is accepted, resume Lane 9 and close CQ-158 through CQ-161.
3. Stop before Lane 10.

Do not start Lane 10 in the next loop. Lane 10 requires a cutover-specific
governor decision after Lane 9 is complete.

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
