# rearch-2 Current Status

Updated: 2026-05-20 after Codex/governor acceptance of Lane 6.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **accepted**.
- Lane 4 Server: **accepted** by Codex/governor on 2026-05-20.
- Lane 5 Sync protocol: **accepted** by Codex/governor on 2026-05-20.
- Lane 6 Read API: **accepted** by Codex/governor on 2026-05-20.
- Lane 7 CLI and MCP: **in progress** — slices 1-10 landed on main
  plus CQ-150/151/152/153 fixes. Open: slice 10b (route migration
  off tRPC), slice 11 (E2E smoke), CQ-149
  (`prosa.refresh_authority` MCP tool).
- Lane 8 Audit and GC: **integrated to main** — audit cron handlers
  (hourly/daily/weekly/monthly), GC three-phase lifecycle, drift
  surface (quarantine + receipt_audit_state + repair field), 503
  `DATA_UNAVAILABLE` artifact fallback, and Prometheus metrics
  landed via parallel worktree merge. Lane 8 gate checkboxes
  closed.
- Lane 9 Migration: **integrated to main** — `prosa migrate-v2
  bundle` (local) + `prosa migrate-v2 tenant` + `POST
  /v2/migrate/tenant` + `legacy_receipt_archive` landed via
  parallel worktree merge. Lane 9 gate items pending final
  baseline batch on integrated main.
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

## Next Loop

Run Lanes 7, 8, and 9 in sequence inside one Ralph loop:

1. Lane 7 — CLI and MCP consumers for the Lane 6 read API.
2. Lane 8 — Audit and GC cron behavior, quarantine/degraded authority surface,
   and metrics.
3. Lane 9 — Local and remote v1-to-v2 migration tooling.

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
