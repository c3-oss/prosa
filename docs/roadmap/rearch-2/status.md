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

- CQ-123: closed (2026-05-20). The `opaqueAuthIdSchema` wire-schema
  relaxation is now complemented by a real end-to-end lifecycle pin in
  `apps/cli/test/cli/v2/sync/promote.test.ts` (signup → BeginPromotion →
  uploads → seal → client `promotionReceiptV2Schema.safeParse` + JWKS
  signature verify). The CLI test signs up via Better Auth and asserts
  the returned receipt's `payload.tenantId` matches the mixed-case
  organization id end-to-end.
- CQ-124: v1 and v2 schemas share table names with incompatible
  columns. The conflict-free subset is now centralized behind
  `applyV2PromotionSubsetSchema` (used by production boot and every
  test entry point), but the underlying v1/v2 cutover is deferred to
  Lane 10 — CQ-124 acceptance (full `applySchemaV2` over v1, projection
  / search materialization) remains open until that cutover lands.
- CQ-125: closed (2026-05-20). BeginPromotion's `already_promoted` fast
  path gates on three independent checks before returning the stored
  receipt: tuple integrity (load-scoped to authority tuple, refuse on
  mismatch), content-addressed derived id
  (`deriveReceiptId(payload) === payload.receiptId`), and signature
  verification via the server's JWKS-published signer. Receipt is only
  returned when `payload.deviceId === request.device.deviceId`. Pinned
  by `cq-125-authority-integrity` (4 tuple cases) and
  `cq-125-receipt-validation` (4 cases: tamper, bogus sig, foreign
  signer, happy-path replay).
- CQ-126: closed (2026-05-20). Boot applies the conflict-free v2 subset via
  the canonical helper `applyV2PromotionSubsetSchema`, the
  `search_generation_current` migration is idempotent and pinned by
  CQ-137, and `apps/api/test/v2/cq-126-server-boot-schema.test.ts` now
  includes an authenticated BeginPromotion case that proves
  `remote_authority_v2` / `promotion_staging` / `device` all resolve
  against the boot-applied schema. Test wording no longer claims CQ-124
  closure. Repo-wide `pnpm lint` and `pnpm typecheck` green.
- CQ-127: BeginPromotion and opt-in post-begin device checks exist, but closure
  is rejected until device identity is mandatory/derived on upload, object-pack,
  seal, status, and receipt surfaces, and CLI `sync-v2` sends/proves it.
- CQ-128: closed (2026-05-20). The partial unique index over active
  `(tenant_id, store_id, bundleRoot)` rows + `INSERT ... ON CONFLICT DO
  NOTHING` collapse 8 concurrent `BeginPromotion`s to a single
  promotionId. Status/resume digest-domain alignment and inventory-ref
  conflict semantics remain watch points (Lane 5 slice 8 caveat below).
- CQ-132: closed (2026-05-20). The cleanup branch re-reads `remote_pack`
  after a non-idempotent catalog failure and only deletes bytes when no
  catalog row references the pack — race-interleaving case is pinned by
  the 4th case in `cq-132-orphan-cleanup.test.ts`.
- CQ-133: per-promotion pack linkage exists. Its CQ-141 dependency
  (missing-byte / wrong-metadata fast path + seal pack-presence) is closed;
  the remaining CQ-133 acceptance is the linkage itself surviving Docker
  E2E.
- CQ-134: SealPromotion can emit receipt/authority before proving object
  coverage by object id, pack-byte presence, or projection/search
  materialization; receipt verification flags can claim success for deferred
  work.
- CQ-135: closed (2026-05-20). `seal-promotion.ts` wraps every post-flip
  step (pack lookup, payload build, `signer.currentKeyId()`, payload
  bytes, `signReceipt`, the load-bearing transaction) inside a single
  try/catch that restores the staging row from `materializing` back to
  its prior status. Pinned by three failure-injection cases in
  `cq-135-seal-restore.test.ts` (signer failure, currentKeyId failure,
  transaction failure); retry with a working signer seals successfully.
- CQ-136: closed (2026-05-20). Both sealed-replay branches (normal
  `status='sealed'` and race-loser) now go through
  `loadAndValidateLinkedReceipt`, which validates tuple integrity,
  content-addressed derived id, and Ed25519 signature against the server
  JWKS. Pinned by `cq-136-resale.test.ts` (3 tuple cases) plus
  `cq-136-link-validation.test.ts` (3 cases: derived-id mismatch, bogus
  signature, foreign-signer signature).
- CQ-137: closed (2026-05-20) alongside CQ-126. Production boot, every
  test entry point, and the Docker E2E bootstrap apply the legacy-shape
  migration through `applyV2PromotionSubsetSchema`'s
  `SEARCH_GENERATION_ONLY_SQL` block. The authenticated CQ-126 boot-path
  test proves BeginPromotion reaches the boot-applied v2 query/write layer;
  `cq-137-store-scoped-generation.test.ts` proves the seal-time
  `(tenant_id, store_id)` upsert behavior.
- CQ-138: GetReceipt now checks id/tuple/derived-id/signature, but closure
  remains open until shared receipt schema validation is resolved and CLI
  receipt validation is proven.
- CQ-140: focused v2 E2E can pass with Docker env, but the documented `just e2e`
  recipe fails and the gate still does not prove command-level `prosa sync-v2`,
  API container, or second-device remote read.
- CQ-141: closed (2026-05-20). UploadObjectPack's catalog fast path now
  handles healthy / missing / wrong-content storage states via a
  `delete() + putIfAbsent()` rewrite when stored bytes disagree with the
  uploaded body's hash or length, and `SealPromotion` `head()`s every
  linked pack before the authority swap (missing/zero-length packs throw
  `SealPromotionPackBytesMissingError` → `409 PACK_BYTES_MISSING`). Pinned
  by `apps/api/test/v2/sync/cq-141-wrong-metadata-and-seal-presence.test.ts`
  (4/4).

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
- Slice 9 focused v2 E2E is useful Postgres/S3 adapter evidence, but it is not
  accepted as the Lane 5 Docker E2E gate: no-env runs skip, `just e2e` fails,
  and the test uses in-process Fastify rather than `prosa sync-v2`.
- CQ-129, CQ-130, and CQ-131 have focused green smoke and are accepted by the
  governor as of 2026-05-20. CQ-132's earlier rejection (concurrent
  delete-after-catalog race) is resolved by the race-interleaving re-check
  in the 2026-05-20 closure. CQ-139 is structurally accepted for removing
  argv bearer tokens, but command-level CLI coverage is still desirable.
- CQ-135's earlier `a867e93` rejection (no failure-injection tests) is
  resolved by the 2026-05-20 closure adding three failure-injection cases
  in `cq-135-seal-restore.test.ts`.
- CQ-138 closure claims from `cba2b90`/`6557852` are rejected pending the
  reviewer-smoked shared-schema validation case. CQ-137 was rejected on
  the schema-upgrade / production boot migration axis; that gap is closed
  in 2026-05-20 alongside CQ-126. CQ-136 was rejected on the race-loser
  + derived-id/signature axis; both are resolved by the 2026-05-20
  closure (`loadAndValidateLinkedReceipt` covers both replay branches).
- CQ-138 closure claims from `11447b7`/`9aff136` remain rejected/partial
  pending CLI/shared-schema receipt validation.
- CQ-127 closure from `0e59a43` is rejected because post-begin checks are
  optional via `x-prosa-device-id`, CLI does not send the header, and GetReceipt
  remains tenant-wide.
- CQ-123 closure from `3f313f0` is rejected as partial; that gap is resolved
  by the 2026-05-20 closure (`promote.test.ts` adds the lifecycle proof
  with `promotionReceiptV2Schema.safeParse` + JWKS verify of a real
  Better Auth signup-derived receipt).
- CQ-125's earlier `41642b3` rejection (device-mismatch + malformed-sig
  cases) is resolved by the 2026-05-20 closure: `verifyReceipt` +
  `deriveReceiptId` checks plus the device-only return gate. CQ-141's
  earlier `f1d15b3` rejection (wrong-metadata fast path +
  seal-after-pack-byte-loss) is resolved by the 2026-05-20 closure above.
- CQ-126 was reopened twice (rejection of `ea46899` and the earlier WIP
  helper slice). The 2026-05-20 closure addresses both: the
  `search_generation_current` legacy-shape upgrade is idempotent and pinned
  by CQ-137; the cq-126 test now asserts an authenticated BeginPromotion
  reaches `200 needs_inventory` against the boot-applied schema.
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
