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

- CQ-123: `opaqueAuthIdSchema` now covers Better Auth mixed-case tenant/store/
  device ids, but closure is rejected until a real signup → promote → seal →
  GetReceipt → client schema/JWKS verification lifecycle is proven.
- CQ-124: v1 and v2 schemas share table names with incompatible
  columns. Blocks Lane 5 slice 3 (materialization paths) and Lane 10
  cutover; slice 1 sidesteps it by applying only the conflict-free
  promotion block in tests.
- CQ-125: BeginPromotion no-op fast path now checks part of the authority
  receipt tuple, but closure is rejected until requested device binding,
  malformed/schema-invalid receipt rejection, and signature verification are
  proven.
- CQ-126: production-style boot now applies conflict-free v2 tables, but closure
  is rejected until boot verifies/migrates old `search_generation_current`
  column shape and an authenticated BeginPromotion reaches the SQL path cleanly.
- CQ-127: BeginPromotion and opt-in post-begin device checks exist, but closure
  is rejected until device identity is mandatory/derived on upload, object-pack,
  seal, status, and receipt surfaces, and CLI `sync-v2` sends/proves it.
- CQ-128: BeginPromotion race safety is now pinned by focused tests, but the
  broader status/resume digest-domain and inventory-ref conflict acceptance
  items remain watch points until directly proven.
- CQ-132: cleanup-on-catalog-failure has focused tests, but closure is rejected
  until a concurrent interleaving proves a failed request cannot delete bytes
  after another request catalogues the same pack.
- CQ-133: per-promotion pack linkage exists, but full acceptance remains blocked
  by CQ-141's missing-byte fast-path case.
- CQ-134: SealPromotion can emit receipt/authority before proving object
  coverage by object id, pack-byte presence, or projection/search
  materialization; receipt verification flags can claim success for deferred
  work.
- CQ-135: signer or transaction failure after the seal status flip can strand
  staging in `materializing`, blocking retry/resume.
- CQ-136: normal sealed replay now validates tuple fields, but closure remains
  open until race-loser replay and linked-receipt schema/derived-id/signature
  validation fail closed.
- CQ-137: package schema migration for `search_generation_current` exists, but
  closure remains open until production/startServer boot uses that migration
  path for old tenant-wide table shapes.
- CQ-138: GetReceipt now checks id/tuple/derived-id/signature, but closure
  remains open until shared receipt schema validation is resolved and CLI
  receipt validation is proven.
- CQ-140: focused v2 E2E can pass with Docker env, but the documented `just e2e`
  recipe fails and the gate still does not prove command-level `prosa sync-v2`,
  API container, or second-device remote read.
- CQ-141: `UploadObjectPack` repairs catalog rows whose object-store bytes are
  missing, but closure is rejected until wrong-metadata fast paths and
  seal-after-pack-byte-loss fail closed.

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
  governor as of 2026-05-20. CQ-132 is not accepted after reviewer coverage
  found the concurrent delete-after-catalog race. CQ-139 is structurally
  accepted for removing argv bearer tokens, but command-level CLI coverage is
  still desirable.
- CQ-135 closure from `a867e93` is rejected pending explicit failure-injection
  tests for signer, transaction, and post-flip pre-sign failures.
- CQ-136/CQ-137/CQ-138 closure claims from `cba2b90`/`6557852` are rejected
  pending the reviewer-smoked corrupt-link, schema-upgrade, and shared-schema
  validation cases.
- CQ-136/CQ-137/CQ-138 closure claims from `11447b7`/`9aff136` remain
  rejected/partial pending race-loser sealed replay, production boot migration,
  and CLI/shared-schema receipt validation.
- CQ-127 closure from `0e59a43` is rejected because post-begin checks are
  optional via `x-prosa-device-id`, CLI does not send the header, and GetReceipt
  remains tenant-wide.
- CQ-123 closure from `3f313f0` is rejected as partial until lifecycle evidence
  proves real Better Auth ids parse and verify through client receipt handling.
- CQ-125/CQ-141 closure claims from `41642b3`/`f1d15b3` are rejected pending
  reviewer-smoked device-mismatch, malformed-signature, wrong pack metadata,
  and seal-after-pack-byte-loss cases.
- CQ-126 closure from `ea46899` is rejected pending reviewer-smoked old
  `search_generation_current` shape and authenticated boot-path proof.
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
