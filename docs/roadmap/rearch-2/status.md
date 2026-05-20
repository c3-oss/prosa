# rearch-2 Current Status

Updated: 2026-05-20 after Lane 5 CQ batch validation.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **accepted** after five documented 180-second
  stabilization cycles.
- Lane 4 Server: **accepted** by Codex/governor on 2026-05-20.
- Lane 5 Sync protocol: **next active milestone**.
- Lanes 6–10: **not started**.

## Current Lane 5 focus

Lane 4 final gates are green and CQ-119, CQ-120, CQ-121, and CQ-122 are closed.
Codex/governor accepts Lane 4 after the user explicitly waived the remaining
fresh stabilization wait on 2026-05-20. Lane 5 is now the active milestone.

Current explicit milestone:

1. Implement the Lane 5 four-call promotion protocol.
2. Add CLI `prosa sync-v2`, resume/no-op behavior, and receipt verification.
3. Collect Docker-backed E2E evidence before Lane 5 acceptance.

Do **not** add more pure-read/audit/CLI surfaces unless they directly unblock
the Lane 5 promotion protocol or validate a Lane 5 gate.

## Lane 4 Server scope

Lane 4 scope is limited to the server foundation from
`docs/rearch-2/05-lane-4-server.md`: `packages/prosa-db-v2` schema and
`applySchemaV2`, `apps/api/src/v2/` boot skeleton, preserved auth context,
server receipt signing/JWKS, bounded streaming pack validation, cron/advisory
lock skeleton, and v2 promotion route definitions that return 501.

Lane 5 scope is the four-call promotion protocol: `BeginPromotion` -> upload
inventory/object packs -> `SealPromotion` -> `GetReceipt`, plus CLI `sync-v2`,
resume/no-op behavior, receipt verification, and Docker-backed E2E evidence.

## Important correction

The prior claim that the Lane 3 runtime executors were blocked by `pnpm-workspace.yaml` `allowBuilds` was wrong. Direct smoke tests showed both native dependencies are runtime-available:

- `@duckdb/node-api` can create an in-memory DB and run `SELECT 42`.
- `@oxdev03/node-tantivy-binding` can build a schema.

The blocker is implementation work, not environment.

## Open blockers

Only CQs that remain BLOCKING for Lane 5 acceptance. Closed CQs are
summarized under "Closed this cycle" below; the full closure detail
lives in `docs/roadmap/rearch-2/correction-queue.md`.

- CQ-124: v1 and v2 schemas share table names with incompatible
  columns. The conflict-free subset is now centralized behind
  `applyV2PromotionSubsetSchema` (used by production boot and every
  test entry point), but the underlying v1/v2 cutover is deferred to
  Lane 10 — CQ-124 acceptance (full `applySchemaV2` over v1, projection
  / search materialization) remains open until that cutover lands.
  Lane 5 acceptance proceeds with the subset workaround documented.
- CQ-134: SealPromotion can emit receipt/authority before proving object
  coverage by object id, projection rows, and search docs. The
  pack-byte-presence sub-bullet is closed by CQ-141; the projection /
  search materialization sub-bullets are blocked on CQ-124 and remain
  Lane 6 / Lane 10 scope.

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
- **CQ-141** (UploadObjectPack wrong-content rewrite + seal pack-bytes-missing fail-closed).
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
- `pnpm typecheck` + `pnpm lint` repo-wide → clean (13/13 packages).
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
  Remaining Lane 5 acceptance caveats are Lane 10 cutover work
  (CQ-124, CQ-134) — explicitly out of Lane 5 scope per the
  initial plan.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
