# Ralph Loop: rearch-2 Lane 5 sync protocol

## Mission

Continue `rearch-2` after accepted Lane 4 Server closeout. The next core milestone is
**Lane 5 Sync protocol: BeginPromotion -> Upload -> Seal -> GetReceipt, plus
CLI sync-v2 and Docker-backed E2E evidence**.

Lane 4 is accepted by Codex/governor. Start Lane 5; do not start Lane 6 or any
read/CLI/MCP expansion outside the sync protocol.

## Read first

1. `AGENTS.md`
2. `docs/rearch-2/00-README.md`
3. `docs/rearch-2/05-lane-4-server.md`
4. `docs/rearch-2/06-lane-5-sync-protocol.md`
5. `docs/architecture/server-sync.md`
6. `docs/roadmap/rearch-2/status.md`
7. `docs/roadmap/rearch-2/correction-queue.md`
8. `docs/roadmap/rearch-2/gates.md`
9. `docs/roadmap/rearch-2/evidence/lane-04.md`
10. `docs/roadmap/rearch-2/evidence/lane-05.md`

## Current milestone

Lane 5 Sync protocol.

Classify all new work against that milestone:

- Core milestone work: server endpoints under `apps/api/src/v2/sync/`,
  inventory upload handling, object-pack upload handling using the Lane 4
  validator, transactional `SealPromotion`, `GET /v2/receipts/:receiptId`,
  `apps/cli/src/cli/v2/sync/`, `prosa sync-v2`, resume/no-op behavior, and
  Docker-backed E2E.
- Required support work: protocol fixtures, inventory builders, focused
  route/transaction tests, idempotency helpers, local object-store/MinIO harness
  glue, signer/JWKS test helpers, and evidence updates directly validating Lane
  5 gates.
- Premature/later-lane surface: Lane 6 read API expansion, Lane 7 CLI/MCP read
  surfaces, Lane 8 audit/GC implementation beyond the Lane 4 cron skeleton,
  dashboards, broad diagnostics, migration/cutover work, or any read-side
  feature that does not directly validate the promotion protocol.

If three consecutive commits are support or premature surface without core Lane
5 progress, stop and redirect to the promotion protocol.

## Current blocking corrections

Read `docs/roadmap/rearch-2/correction-queue.md` before the next slice.

- CQ-123 blocks Lane 5 acceptance: Better Auth mixed-case tenant ids do not
  satisfy the current v2 receipt/wire schemas, so client-side receipt parsing
  and I5 verification cannot pass end-to-end.
- CQ-124 blocks Lane 5 seal/materialization acceptance: v1 and v2 schemas share
  incompatible table names, so full v2 schema boot/materialization cannot be
  validated on the current shared public schema. It does not block independent
  BeginPromotion/upload slices, but it must be resolved before slice 3 seal
  acceptance.
- CQ-125 blocks Lane 5 BeginPromotion acceptance: the no-op fast path must fail
  closed when `remote_authority_v2` points to a missing, malformed, or mismatched
  receipt, and valid `already_promoted` replies must prove the receipt matches
  the requested authority tuple.
- CQ-126 blocks Lane 5 production/Docker E2E acceptance: server boot must apply
  or verify the conflict-free v2 promotion tables before registering usable v2
  promotion routes.
- CQ-127 blocks Lane 5 authorization acceptance: BeginPromotion must verify
  device ownership/policy and must not return another device's receipt by only
  proving tenant membership.
- CQ-128 blocks Lane 5 retry/resume and upload/seal acceptance: concurrent
  `BeginPromotion` calls for the same active tuple must be atomic and return a
  single promotion id / staging row.
- CQ-129 blocks Lane 5 object-pack upload acceptance: object-store metadata must
  use the transport-byte hash, while `remote_pack.pack_digest` remains the
  canonical CAS pack digest.
- CQ-130 blocks Lane 5 upload-segment acceptance: missing
  `x-prosa-transport-hash` must reject, not accept, on segment and object-pack
  uploads.
- CQ-131 blocks Lane 5 seal/upload phase acceptance: uploads must reject once
  staging is `materializing`.
- CQ-132 blocks Lane 5 object-pack cleanup acceptance: bytes written before a
  catalog failure must be deleted or explicitly queued for cleanup.
- CQ-133 blocks Lane 5 seal grant correctness: uploaded object packs must be
  durably linked to the promotion that uploaded or claimed them.
- CQ-134 blocks Lane 5 seal acceptance: do not emit authority receipts until
  object coverage, projection rows, and search docs are proven or seal fails
  closed.
- CQ-135 blocks Lane 5 retry/resume acceptance: signer/transaction failure after
  seal status flip must not strand staging in `materializing`.
- CQ-136 blocks Lane 5 idempotency: re-sealing an old promotion must return that
  promotion's receipt, not current store authority.
- CQ-137 blocks Lane 5 search authority: `search_generation_current` scope must
  align with store-scoped remote authority.
- CQ-138 blocks Lane 5 GetReceipt/CLI acceptance: `GET /v2/receipts/:receiptId`
  and `prosa sync-v2` must not accept unvalidated, tuple-mismatched, or
  wrongly signed same-tenant receipts as authority.
- CQ-139 blocks Lane 5 CLI acceptance: `prosa sync-v2` must not require bearer
  tokens in argv for the normal command path.
- CQ-140 blocks Lane 5 Docker E2E acceptance: the documented `just e2e` recipe
  must be green and the evidence must distinguish route-level Postgres/S3 E2E
  from the still-required command-level `prosa sync-v2` gate.

## Lane 5 invariants

- Sync direction is one-way: local bundle to remote server.
- The server is an authoritative replica of promoted data; it must not derive
  canonical rows the client did not promote.
- Object identity is canonical BLAKE3 over original bytes; transport hash is
  separate and must be verified independently.
- Tenant membership, device ownership, and object routes share authorization
  semantics. Never widen queries past tenant/device scope.
- `verifyPromotion` is the cleanup gate and must prove declared objects, source
  files, raw records, sessions, and search docs before any receipt is accepted.
- Seal is the only authority-swap path. No code except the seal implementation
  may write `remote_authority_v2`, `search_generation_current`, or
  `receipt_pack_grant`.
- Orphan uploaded bytes must be cleaned up or aborted when catalog/materialization
  fails.

## Implementation order

Work in committed slices with focused evidence:

1. Server `BeginPromotion` route: validate `BundleHeadV2`, resolve tenant/device,
   implement already-promoted no-op fast path, open staging, and return missing
   inventory/object requirements.
2. Inventory and object uploads: stream validate bytes, verify transport hash
   separately from canonical object identity, persist missing objects, and keep
   uploads idempotent.
3. `SealPromotion`: verify all declared segments/objects/materialized rows,
   materialize projection/search docs, sign a receipt, and perform the authority
   swap in one Postgres transaction.
4. `GET /v2/receipts/:receiptId`: tenant-scoped receipt fetch that validates
   request id, row/payload tuple, shared receipt schema, and JWKS signature;
   return 404 for wrong tenant and fail closed for corrupt same-tenant rows.
5. CLI `prosa sync-v2`: build inventories, upload missing data, seal, persist
   receipt/checkpoint state only after schema/JWKS/tuple validation, support
   retry/resume, `--no-resume`, `--dry-run`, `--json`, safe token sourcing, and
   useful failure output.
6. Docker-backed E2E: API + Postgres + object storage + CLI sync + second device
   remote read.

## Blocker verification

Any blocker claim about Docker, Postgres, object storage, KMS/signing, native
dependencies, package manager policy, or missing APIs must include a direct
smoke command and exact output before rerouting.

If the blocker is architectural, ask one explicit binary question with a safe
default. Do not spin on vague external acceptance.

## Gates

Lane 5 is not accepted until these are green and recorded in
`docs/roadmap/rearch-2/evidence/lane-05.md`:

```text
pnpm --filter @c3-oss/prosa-api test
pnpm --filter @c3-oss/prosa test
pnpm typecheck
pnpm lint
git diff --check
```

Required smoke/E2E evidence:

- Fresh `prosa sync-v2` promotion succeeds against Docker-backed API/Postgres/
  object storage.
- Re-promoting the same bundle uses the no-op fast path and completes in under
  2 seconds.
- Resume after interruption does not re-upload already-staged bytes.
- `prosa sync-v2 --no-resume` ignores checkpoint state and still succeeds.
- Receipt verifies against JWKS.
- A second device can read the promoted remote data.
- Invariants I1, I2, I3, I4, and I5 pass for the promotion path.

## Completion rule

Do not output `RALPH_DONE` unless all gates/evidence/CQs are clean and five
consecutive 180-second stabilization cycles for Lane 5 are documented. If Lane 5
reaches its gate, stop for Codex/governor acceptance before starting Lane 6.
