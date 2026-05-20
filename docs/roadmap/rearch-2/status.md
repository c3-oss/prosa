# rearch-2 Current Status

Updated: 2026-05-20 after Lane 5 slice 6 review and CLI sync-v2 WIP.

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

- CQ-123: Better Auth tenant_id values do not satisfy
  `canonicalIdSchema`. Blocks Lane 5 acceptance because client-side
  receipt schema parses fail against mixed-case tenant ids. Slice 1
  worked around it server-side via opaque local schemas; full fix is
  required before E2E gates can pass.
- CQ-124: v1 and v2 schemas share table names with incompatible
  columns. Blocks Lane 5 slice 3 (materialization paths) and Lane 10
  cutover; slice 1 sidesteps it by applying only the conflict-free
  promotion block in tests.
- CQ-125: BeginPromotion no-op fast path does not verify that the
  authority row's receipt matches the requested tenant/store/root/device
  tuple and fail-opens orphan authority rows into fresh promotion.
- CQ-126: production-style boot registers v2 promotion routes without
  applying/verifying v2 promotion tables, so a v1-only database can pass
  health and fail the first BeginPromotion query.
- CQ-127: BeginPromotion proves tenant membership but not device
  ownership/policy; UploadSegment inherits the same gap and can accept staged
  bytes from another same-tenant user/device.
- CQ-128: BeginPromotion staging idempotency is sequential only; concurrent
  same-tuple calls can create two active `promotion_staging` rows and two
  promotion ids.
- CQ-129: UploadObjectPack WIP writes object-store metadata with canonical
  `packDigest` instead of the BLAKE3 transport hash of the stored bytes, causing
  valid pack uploads to fail storage verification.
- CQ-130: UploadSegment accepts inventory bytes without the required
  `x-prosa-transport-hash`; UploadObjectPack has the same optional-header gap.
- CQ-131: UploadSegment and UploadObjectPack accept uploads while staging is
  already `materializing`.
- CQ-132: UploadObjectPack writes object-store bytes before catalog rows and
  lacks cleanup on non-idempotent catalog failure.
- CQ-133: UploadObjectPack commit `154ba25` did not link tenant-wide pack
  catalog rows to the promotion that uploaded them; current WIP appears to add
  `promotion_uploaded_pack`, but it is not yet committed/gated.
- CQ-134: SealPromotion can emit receipt/authority before proving object
  coverage or projection/search materialization; receipt verification flags can
  claim success for deferred work.
- CQ-135: signer or transaction failure after the seal status flip can strand
  staging in `materializing`, blocking retry/resume.
- CQ-136: idempotent re-seal of an old promotion can return the current store
  receipt instead of that promotion's receipt.
- CQ-137: `search_generation_current` is tenant-wide while remote authority is
  store-scoped; the scope decision needs implementation and tests.
- CQ-138: GetReceipt returns object-shaped same-tenant receipts without proving
  request id, row/payload tuple, shared receipt schema, JWKS signature, or the
  accepted device/user access policy; CLI WIP also trusts receipts by cast.
- CQ-139: `prosa sync-v2` requires `--token <token>`, exposing bearer tokens in
  shell history/process listings; Lane 5 CLI acceptance needs a safe token
  source.

## Current gate caveats

- Slice 6 focused GetReceipt smoke is green:
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/get-receipt.test.ts`
  passed 4/4.
- CLI slice 7 / status WIP focused smoke is green:
  `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote.test.ts`
  passed 4/4, and
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/get-promotion-status.test.ts`
  passed 5/5.
- These focused tests prove route/client mechanics only. They do not close
  runtime receipt validation, safe token sourcing, command-level CLI coverage,
  pack-skip resume, sealed checkpoint recovery, Docker E2E, or stabilization.
- Slice 8 reviewer smokes confirmed `packDigest !== transportHash`, so current
  pack-skip resume compares different digest domains and normally re-uploads
  packs. Status-assisted inventory skip also relies on object-store presence,
  not stored hash/size verification.
- Reviewer aggregate smoke
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` failed 77/78 with
  a timeout in the malformed-body BeginPromotion case, while the same file
  passed 7/7 in isolation. Do not accept the recorded 78/78 aggregate gate until
  a fresh aggregate run is green or the timeout is fixed/documented.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
