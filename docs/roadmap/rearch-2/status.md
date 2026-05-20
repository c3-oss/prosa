# rearch-2 Current Status

Updated: 2026-05-20 after Lane 6 slice 7 governor review.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **accepted** after five documented 180-second
  stabilization cycles.
- Lane 4 Server: **accepted** by Codex/governor on 2026-05-20.
- Lane 5 Sync protocol: **accepted** by Codex/governor on 2026-05-20.
- Lane 6 Read API: **active**, slice 7 landed and analytics WIP continues.
  CQ-142 is accepted for signed cursors and route-level invalid-cursor
  coverage. CQ-143 remains open for session detail/show command proof; CQ-145
  remains open for complete route-level artifact cases; CQ-146 is open for
  production cursor HMAC signer wiring.
- Lanes 7–10: **not started**.

## Current Lane 6 focus

Lane 5 final gates are green. CQ-141 closure attempt #4 is accepted by
Codex/governor after the focused replay/route reviewer passed the integrity
checks. Five or more fresh 180-second stabilization cycles are documented in
`evidence/stabilization-lane-05.md`; the loop continued through cycle 14 while
awaiting governor acceptance.

Current explicit milestone:

1. Implement the Lane 6 receipt-pinned remote read API from
   `docs/rearch-2/07-lane-6-read-api.md`.
2. Gate every read on verified current authority for the tenant/store.
3. Add focused read-route tests plus performance/cache evidence before Lane 6
   acceptance.

Do **not** add Lane 7 CLI/MCP read surfaces, broad dashboards, or audit/GC
implementation unless they directly validate the Lane 6 API contract.

## Lane 4 Server scope

Lane 4 scope is limited to the server foundation from
`docs/rearch-2/05-lane-4-server.md`: `packages/prosa-db-v2` schema and
`applySchemaV2`, `apps/api/src/v2/` boot skeleton, preserved auth context,
server receipt signing/JWKS, bounded streaming pack validation, cron/advisory
lock skeleton, and v2 promotion route definitions that return 501.

Lane 5 scope was the four-call promotion protocol: `BeginPromotion` -> upload
inventory/object packs -> `SealPromotion` -> `GetReceipt`, plus CLI `sync-v2`,
resume/no-op behavior, receipt verification, and Docker-backed E2E evidence.

Lane 6 scope is the receipt-pinned read API: authority refresh, sessions
list/count/detail/transcript, search, tool calls, artifacts.getText, analytics,
cursor stability, query-time cross-store aggregation, cache TTL evidence, and
verified-projection gates.

## Important correction

The prior claim that the Lane 3 runtime executors were blocked by `pnpm-workspace.yaml` `allowBuilds` was wrong. Direct smoke tests showed both native dependencies are runtime-available:

- `@duckdb/node-api` can create an in-memory DB and run `SELECT 42`.
- `@oxdev03/node-tantivy-binding` can build a schema.

The blocker is implementation work, not environment.

## Open blockers

Only CQs that remain BLOCKING for future acceptance. Closed CQs are summarized
under "Closed this cycle" below; the full closure detail lives in
`docs/roadmap/rearch-2/correction-queue.md`.

- CQ-124: v1 and v2 schemas share table names with incompatible
  columns. The conflict-free subset is now centralized behind
  `applyV2PromotionSubsetSchema` (used by production boot and every
  test entry point), but the underlying v1/v2 cutover is deferred to
  Lane 10 — CQ-124 acceptance (full `applySchemaV2` over v1, projection
  / search materialization) remains open until that cutover lands.
  Lane 5 is accepted with the subset workaround documented. Full acceptance of
  CQ-124 remains Lane 10 scope and must not be silently folded into Lane 6.
- CQ-134: SealPromotion can emit receipt/authority before proving object
  coverage by object id, projection rows, and search docs. The
  pack-byte-presence sub-bullet is closed by accepted CQ-141. The projection /
  search materialization sub-bullets are blocked on CQ-124 and remain Lane 10
  cutover scope. Lane 6 reads may only expose rows that already exist and are
  proven by current authority; they must not fake materialization.
- CQ-142: accepted by Codex/governor for cursor integrity, empty cursor
  rejection, and HTTP 400 `INVALID_CURSOR` route coverage on all four
  paginated routes. Residual production key wiring is CQ-146.
- CQ-143: promoted `prosa sessions` reads still route through legacy
  `/trpc/sessions.*`. Until Lane 7 wires `/v2/reads/*`, they must fail closed
  for promoted v2 stores instead of bypassing the Lane 6 authority gate.
  Current tests prove sessions and sessions count fail closed before network
  access; session detail/show still needs an executable no-call pin.
- CQ-144: accepted by Codex/governor for handler-level artifacts opacity.
  Final Lane 6 acceptance still needs route-level artifacts evidence.
- CQ-145: the missing-artifact route no longer returns 500, but route-level
  tests still need missing grant/object, missing bytes/fetch, valid small text,
  and bounded large/binary cases.
- CQ-146: production cursor HMAC signer wiring is missing; production currently
  falls back to per-process random cursor keys unless a signer is injected by
  code, and no config/env path exists.

## Closed this cycle

All closed on 2026-05-20 — see `correction-queue.md` for full detail:

- **CQ-123** (Better Auth ids end-to-end through schema parse + JWKS verify).
- **CQ-125** (BeginPromotion: tuple + deriveReceiptId + signature on fast path).
- **CQ-126** (canonical `applyV2PromotionSubsetSchema` for boot + authenticated boot-path test).
- **CQ-127** (mandatory `x-prosa-device-id` + GetReceipt scoping + CLI header propagation).
- **CQ-128** (race-safe `BeginPromotion` via partial unique index + ON CONFLICT).
- **CQ-132** (race-interleaving re-check before deleting orphan pack bytes).
- **CQ-133** (per-promotion `promotion_uploaded_pack` linkage).
- **CQ-135** (post-flip try/catch wraps every step; staging restored on any failure).
- **CQ-136** (both sealed-replay branches go through `loadAndValidateLinkedReceipt`).
- **CQ-137** (store-scoped `search_generation_current` + idempotent legacy migration).
- **CQ-138** (CLI `promoteBundleV2` schema + deriveReceiptId + JWKS verify every receipt).
- **CQ-141** accepted by Codex/governor after closure attempt #4. Attempt #3
  fixed durable `remote_pack.byte_hash`, seal hash/algorithm/length
  verification, and non-destructive upload repair. Attempt #4 fixed sealed
  replay and race-loser replay by re-running linked-pack byte verification
  before returning an existing receipt, and added route-level 409 tests for
  `PACK_BYTES_CORRUPT`, `PACK_BYTES_MISMATCH`, and both replay failure modes.
- **CQ-140** (`just e2e` + `just e2e-cli` both green; CLI subprocess harness in
  `apps/cli/test/cli/sync-v2-e2e.test.ts` covers `prosa sync-v2` over HTTP
  fetch + JWKS verify + second-device 404).

## Current gate caveats

- `pnpm --filter @c3-oss/prosa-api test` runs the full v2 sync test
  suite green: 281 passed / 4 skipped (the 4 skipped are env-gated
  Docker E2E tests + a pre-existing v1 skip; with the env vars set they
  all pass).
- `pnpm --filter @c3-oss/prosa test` runs the CLI suite green: 295
  passed / 1 skipped.
- `pnpm typecheck` + `pnpm lint` repo-wide were reported clean by Ralph and
  reviewer. Lane 5 acceptance is complete.
- `just e2e` (Docker harness up) → pass, 4/4 (1 v1 + 3 v2 route-level).
  `just e2e-cli` → pass, 3/3 (1 v1 two-device + 2 v2 CLI subprocess +
  second-device read). Fresh no-env runs skip the e2e blocks (skip ≠
  gate proof).
- Slice 8 watch point (CQ-128): `packDigest !== transportHash`, so
  pack-skip resume compares different digest domains and normally
  re-uploads packs. Status-assisted inventory skip relies on
  object-store presence, not stored hash/size verification. Both
  remain documented as low-impact pending work behind the closed
  CQ-128 core.
- CQ-129, CQ-130, CQ-131, CQ-139 accepted by the governor on
  2026-05-20.
- CQ-140 is closed (route-level + CLI subprocess gates both green).
- CQ-124 and CQ-134 materialization remain explicit Lane 10 deferrals, not
  Lane 5 blockers. `RALPH_DONE` for Lane 5 may be accepted; the next prompt
  starts Lane 6.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
