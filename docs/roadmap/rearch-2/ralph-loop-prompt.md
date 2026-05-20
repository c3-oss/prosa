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
4. `GET /v2/receipts/:receiptId`: tenant-scoped receipt fetch that verifies
   against JWKS and returns 404 for wrong tenant.
5. CLI `prosa sync-v2`: build inventories, upload missing data, seal, persist
   receipt/checkpoint state, support retry/resume, `--no-resume`, `--dry-run`,
   `--json`, and useful failure output.
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
