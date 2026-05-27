# Lane 6 Evidence — Read API

Status: accepted by Codex/governor on 2026-05-20.

## Final Evidence

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  72 passed | 2 skipped (74)
Tests       431 passed | 4 skipped (435)
```

Focused CQ-148 evidence:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/tool-calls-list.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
```

Additional gates:

- `pnpm typecheck` passed repo-wide: 13/13 packages.
- `pnpm lint` passed repo-wide: 13/13 packages.
- `git diff --check` passed.
- Read-only reviewer found no blocker for Lane 6 acceptance.

Final transcript wrong-tuple follow-up:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/transcript-pagination.test.ts
Test Files  1 passed (1)
Tests       7 passed (7)
```

## Accepted Scope

- Authority refresh.
- Sessions list/count/detail/transcript.
- Search query.
- Tool calls list.
- `artifacts.getText`.
- Analytics summary/report.
- Cursor snapshot and route integrity.
- Verified projection gates.
- p95 latency smoke evidence.

CQ-148 is accepted: `tool-calls/list` latest-result joins are tuple-matched on
`tool_call_id/session_id/store_id/receipt_id`, with wrong-session,
wrong-receipt, wrong-store, and `errorsOnly` regressions pinned.

The same tuple rule is now applied to `sessions/transcript` latest-result
lookups and pinned by a wrong-session regression.

Historical detail was compacted after Lane 6 acceptance. Use git history before
the Lane 6 closeout commit for the full per-slice audit trail.
