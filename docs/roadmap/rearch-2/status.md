# rearch-2 Current Status

Updated: 2026-05-20 after Lane 4 final gate batch.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **accepted** after five documented 180-second
  stabilization cycles.
- Lane 4 Server: **final gates green / stabilization pending**.
- Lane 5 Sync protocol: **prepared; blocked until Lane 4 acceptance**.
- Lanes 6–10: **not started**.

## Current Lane 4 closeout

CQ-119, CQ-120, CQ-121, and CQ-122 are closed. The v2 route placeholders,
production signing fail-closed behavior, wire-compatible canonical I5 signing,
streaming pack validator, and cron advisory-lock skeleton are implemented and
evidenced for Lane 4 scope.

Current explicit milestone:

1. Commit this Lane 4 closeout and Lane 5 prep alignment.
2. Complete five fresh 180-second Lane 4 stabilization cycles.
3. Accept Lane 4, then start Lane 5 Sync protocol.

Do **not** add more pure-read/audit/CLI surfaces unless they directly unblock
Lane 3 closeout or validate a Lane 4 gate.

## Lane 4 Server scope

Lane 4 scope is limited to the server foundation from
`docs/rearch-2/05-lane-4-server.md`: `packages/prosa-db-v2` schema and
`applySchemaV2`, `apps/api/src/v2/` boot skeleton, preserved auth context,
server receipt signing/JWKS, bounded streaming pack validation, cron/advisory
lock skeleton, and v2 promotion route definitions that return 501.

Lane 5 sync protocol work remains blocked until Lane 4 is accepted. After Lane 4
acceptance, Lane 5 scope is the four-call promotion protocol:
`BeginPromotion` -> upload inventory/object packs -> `SealPromotion` ->
`GetReceipt`, plus CLI `sync-v2`, resume/no-op behavior, receipt verification,
and Docker-backed E2E evidence.

## Important correction

The prior claim that the Lane 3 runtime executors were blocked by `pnpm-workspace.yaml` `allowBuilds` was wrong. Direct smoke tests showed both native dependencies are runtime-available:

- `@duckdb/node-api` can create an in-memory DB and run `SELECT 42`.
- `@oxdev03/node-tantivy-binding` can build a schema.

The blocker is implementation work, not environment.

## Open blockers

No open correction-queue blockers are currently recorded. Lane 4 cannot be
accepted yet because the fresh five-cycle 180-second stabilization count has not
completed after final gate evidence.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
