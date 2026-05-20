# Lane 5 Evidence - Sync protocol

Status: active; Lane 4 accepted on 2026-05-20.

Lane 5 may start now. Lane 4 final gates passed, all Lane 4 CQs are closed, and
Codex/governor accepted Lane 4 after the user explicitly waived the remaining
fresh stabilization wait.

Core scope after Lane 4 acceptance:

- Implement the four-call promotion protocol:
  `BeginPromotion` -> inventory/object uploads -> `SealPromotion` ->
  `GetReceipt`.
- Add CLI `prosa sync-v2` with retries, resume checkpointing, `--no-resume`,
  dry-run/json flags as specified in `docs/rearch-2/06-lane-5-sync-protocol.md`.
- Preserve one-way local-bundle-to-remote sync; the server must not derive data
  the client did not promote.
- Keep object identity as canonical BLAKE3 over original bytes; transport hash
  remains separate.
- Apply projection/search rows only through the seal transaction.
- Prove tenant/device/object authorization parity on every route.

Required support:

- Inventory fixtures/builders, focused route tests, signer/JWKS helpers, local
  object-store or MinIO harness setup, and resume/no-op test fixtures.
- Docker-backed E2E only when the promotion protocol path is wired.

Premature/later-lane surface:

- Lane 6 read API expansion, Lane 7 CLI/MCP read surfaces, Lane 8 audit/GC
  implementation beyond existing cron skeleton, migration/cutover work, and
  broad dashboards/diagnostics.

Initial Lane 5 gates to collect:

```text
pnpm --filter @c3-oss/prosa-api test
pnpm --filter @c3-oss/prosa test
pnpm typecheck
pnpm lint
git diff --check
```

Docker E2E evidence must be added before Lane 5 acceptance.

## Slice 1 (BeginPromotion no-op fast path) — 2026-05-20

Scope:

- New `apps/api/src/v2/sync/begin-promotion.ts` implements `BeginPromotion`
  for the no-op fast path. The handler:
  - Validates the request body with a server-local schema that treats
    `tenantId`, `storeId`, and `deviceId` as opaque strings (Better
    Auth's `organization.id` is a mixed-case nanoid and never matches
    canonical lowercase). The bundle/segment/hash fields keep their
    canonical wire schemas because they are content-addressed.
  - Cross-checks `request.tenantId === ctx.tenantId` (I1) and
    `head.storeId === request.storeId`.
  - Looks up `remote_authority_v2 WHERE tenant_id=$1 AND store_id=$2
    AND current_bundle_root=$3`. On hit, fetches the matching
    `receipt` row (also tenant-scoped) and returns
    `{ status: 'already_promoted', receipt }` verbatim.
  - On miss, returns a `needs_inventory` placeholder with a
    deterministic `prm_<hex>` promotion id derived from
    `(tenant_id, store_id, bundleRoot)`. Real staging-row creation
    and missing-segment computation are deferred to the next slice.
- `apps/api/src/v2/promotion.ts` now dispatches `BeginPromotion` to the
  new handler; the remaining four routes still return 501. The handler
  translates `BeginPromotionValidationError` → `400 INVALID_REQUEST`
  and `BeginPromotionTenantMismatchError` → `403 TENANT_MISMATCH`.
- `apps/api/package.json` adds `@c3-oss/prosa-db-v2` as a workspace
  dependency.
- `apps/api/test/helpers/test-app.ts` applies `PROMOTION_SCHEMA_SQL`
  on top of the v1 schema. v1 and v2 share table names
  (`projection_session`, `search_doc`, `remote_object`, `device`) with
  incompatible column sets, so blanket `applySchemaV2` is unsafe;
  Lane 10 cutover owns the production migration. The v2 promotion
  block is conflict-free.
- `apps/api/src/server.ts` documents why production boot does not call
  `applySchemaV2` yet (same Lane 10 cutover note).
- `apps/api/test/v2/skeleton.test.ts` only enforces 501 on the four
  unimplemented routes; `BeginPromotion` is covered by the new slice
  test.
- New `apps/api/test/v2/sync/begin-fast-path.test.ts` exercises five
  cases:
  1. malformed body → `400 INVALID_REQUEST`.
  2. mismatched body `tenantId` → `403 TENANT_MISMATCH`.
  3. `already_promoted`: pre-seeded `remote_authority_v2` + `receipt`
     rows for `(tenant, store, bundleRoot)` → 200 with the stored
     receipt; `receiptId`, `bundleRoot`, and signature `alg` checked.
  4. Tenant isolation (I1): tenant B requesting tenant A's bundleRoot
     does NOT see `already_promoted`.
  5. Fresh bundle → `needs_inventory` with a deterministic `prm_<hex>`
     promotionId that is stable across repeated calls.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/begin-fast-path.test.ts`
  → pass, 5/5.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  49/49 (44 prior v2 tests + 5 new).
- `pnpm --filter @c3-oss/prosa-api test` → pass, 184/185
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Slice 1 deferred (explicit):

- Staging-row creation, `needs_upload` response with real missing
  segments/objects, and the segment/object-pack/seal/get-receipt
  routes remain 501 and ship in follow-up slices.
- The canonical-tenant-id mismatch between Better Auth (mixed-case
  nanoid) and `prosa-wire-v2`'s `canonicalIdSchema` (lowercase only)
  is worked around server-side via the opaque local schema. Receipt
  payloads stored in the DB therefore carry mixed-case `tenantId`,
  and client-side `promotionReceiptV2Schema.safeParse` will reject
  those payloads. A correction-queue entry tracks the resolution
  (lowercased canonical tenant id at the auth boundary or relaxed
  receipt schema). The slice 1 fast-path test asserts the receipt
  shape directly rather than via the strict wire schema.

## Slice 2 (BeginPromotion opens a real `promotion_staging` row) — 2026-05-20

Scope:

- `apps/api/src/v2/sync/begin-promotion.ts` now persists a real
  `promotion_staging` row when the fast-path lookup misses. The
  handler:
  - Threads `ctx.user.id` into `BeginPromotionDeps.userId`.
  - Looks up an active (`status IN ('open','uploading','materializing')`)
    staging row for `(tenant_id, store_id, head_json->>'bundleRoot')`.
    On hit, returns its id — idempotent retry.
  - Otherwise INSERTs a fresh row with status `'open'`, generating a
    `prm_<base32-lower>` id whose alphabet satisfies `canonicalIdSchema`
    for the response `promotionId`.
  - Treats sealed/aborted rows as terminal and opens a new slot for
    the same `(tenant, store, bundleRoot)` join key.
- `apps/api/src/v2/promotion.ts` passes `ctx.user.id` to the handler.
- New begin-promotion test cases:
  - `returns needs_inventory with a persisted promotion_staging row
    and idempotent retries (slice 2)` — asserts the staging row is
    INSERTed with the expected `tenant_id`, `user_id`, `device_id`,
    `store_id`, `store_path`, `status='open'`, and `head_json.bundleRoot`;
    a second call reuses the row (`count(*) = 1`).
  - `opens distinct staging rows for distinct bundle roots in the same
    store` — proves the lookup key includes `bundleRoot`.
  - `skips terminal sealed/aborted staging rows when reopening a slot`
    — proves the active-status filter forces a fresh row when the
    only existing row is terminal.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/begin-fast-path.test.ts`
  → pass, 7/7.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  51/51.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 186/187
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Slice 2 deferred (explicit):

- Real inventory-presence detection (`needs_upload` transition) needs
  the segment upload route from slice 3 to record what has been
  uploaded.
- Inventory segment uploads, object pack uploads, seal, and
  `GET /v2/receipts/:receiptId` remain 501.

## Slice 3 (UploadSegment route) — 2026-05-20

Scope:

- New `apps/api/src/v2/sync/upload-segment.ts` implements
  `PUT /v2/promotions/:promotionId/segments/:segmentId`:
  - Resolves the staging row by `(id, tenant_id)` so the tenant scope
    is preserved on every lookup (I1). A miss — or a row in
    sealed/aborted status — is `404 PROMOTION_NOT_FOUND`. The status
    check folds into the same code so callers cannot drive new
    uploads against a closed slot.
  - Pulls the declared segment ref from `inventory_object_ref` /
    `inventory_projection_ref`. Unknown `segmentId` → `404
    SEGMENT_NOT_DECLARED`.
  - Verifies the body bytes against the declared segment:
    `byteLength` exact match, BLAKE3 of the body equals the
    canonical `digest`, and the optional
    `x-prosa-transport-hash: blake3:<hex>` header matches the same
    streamed BLAKE3. Any mismatch returns `400 INVALID_REQUEST` with
    a structured `issues` array.
  - `putIfAbsent` writes the bytes to the object store at
    `staging/<tenant>/<promotion_id>/<segment_id>`. Re-upload of the
    same bytes is idempotent and returns `already_present`.
  - Touches `promotion_staging.updated_at`. Status transitions are
    reserved for the seal slice.
- `apps/api/src/v2/sync/begin-promotion.ts` now persists the declared
  `objectInventorySegment` and `projectionInventorySegment` into the
  dedicated `inventory_object_ref` / `inventory_projection_ref`
  columns so the upload route can resolve them by id.
- `apps/api/src/v2/promotion.ts` dispatches `UploadSegment` to the
  new handler, translates `UploadSegmentNotFoundError` →
  `404 <code>` and `UploadSegmentValidationError` →
  `400 INVALID_REQUEST` with `issues`.
- `apps/api/src/v2/index.ts` and `apps/api/src/app.ts` thread the
  `RemoteObjectStore` into the promotion route deps.
- `apps/api/test/v2/skeleton.test.ts` removes `UploadSegment` from
  the 501 set; the slice now owns its own focused tests.
- `apps/api/test/v2/production-signer.test.ts` passes a
  `MemoryObjectStore` into `registerV2Routes` to satisfy the new
  required dep.
- New `apps/api/test/v2/sync/upload-segment.test.ts` covers 9 cases:
  1. unauth → 401.
  2. unknown `promotionId` → 404 PROMOTION_NOT_FOUND.
  3. cross-tenant promotion id → 404 PROMOTION_NOT_FOUND (I1 — no
     existence-by-status leak across tenants).
  4. undeclared `segmentId` → 404 SEGMENT_NOT_DECLARED.
  5. body bytes hash to the wrong digest → 400 with `digest` issue.
  6. body length disagrees with the declared `byteLength` → 400 with
     `byteLength` issue.
  7. `x-prosa-transport-hash` header disagrees with the streamed
     BLAKE3 → 400 with `transportHash` issue.
  8. happy-path upload → 200 `accepted`, body present at
     `staging/<tenant>/<promotion>/<segment>`, re-upload returns
     `already_present`, second declared inventory uploads too.
  9. sealed/aborted staging row refuses new uploads with
     `404 PROMOTION_NOT_FOUND`.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/upload-segment.test.ts`
  → pass, 9/9.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  60/60.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 195/196
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Slice 3 deferred (explicit):

- `BeginPromotion` does not yet flip from `needs_inventory` to
  `needs_upload` when the inventories are uploaded. That transition
  needs the inventory parser + object pack upload route, and ships
  in slice 4.
- Streaming body validation uses the buffered raw body for now; the
  Lane 4 `validatePackStream` pipeline applies to object packs
  (slice 4), not inventory segments which ship as opaque bytes whose
  canonical digest is checked directly.
- Object pack uploads (`POST /v2/promotions/:id/object-packs`),
  seal, and `GET /v2/receipts/:receiptId` remain 501.

## Slice 4 (UploadObjectPack route + remote_pack catalog) — 2026-05-20

Scope:

- New `apps/api/src/v2/sync/upload-object-pack.ts` implements
  `POST /v2/promotions/:promotionId/object-packs`:
  - Resolves the staging row by `(id, tenant_id)` and refuses
    sealed/aborted slots with `404 PROMOTION_NOT_FOUND`.
  - Computes two distinct hashes: `transportHash` (BLAKE3 over the
    wire bytes) and the self-referential `packDigest` from the
    verified pack header. CQ-012 keeps the two separate; CQ-026
    explains why the on-disk digest differs from `BLAKE3(bytes)`.
  - Validates the optional `x-prosa-transport-hash` and
    `x-prosa-pack-digest` headers against the corresponding hashes
    and returns `400 INVALID_REQUEST` with a typed `issues[]`
    payload on mismatch.
  - Runs `verifyCasPack(bytes)` from `@c3-oss/prosa-bundle-v2` — the
    canonical pack verifier checks framing magic/version, canonical
    JSON header bytes, the self-referential pack_digest, the zstd
    window cap, and every entry's `stored_hash` /
    `uncompressed_hash` / `object_id` match.
  - Idempotency: hits the catalog first
    (`SELECT … FROM remote_pack WHERE tenant_id=$1 AND pack_digest=$2`)
    and returns `already_present` when present. Otherwise
    `putIfAbsent` writes the bytes at
    `object-packs/<tenant>/<pack_digest_hex>.pack`. INSERT
    `remote_pack` + N `remote_pack_entry` rows in a transaction;
    a racing duplicate raises `unique_violation` (`23505`) and the
    handler resurfaces it as `already_present`.
  - Hands the literal transport hash to the object store's
    `meta.hash`, since `MemoryObjectStore`/`FsObjectStore` verify
    `BLAKE3(bytes) === meta.hash` and that value is NOT the
    self-referential pack digest.
- `apps/api/src/v2/index.ts`, `apps/api/src/app.ts`, and
  `apps/api/src/v2/promotion.ts` thread the new
  `DatabaseHandle['transaction']` dep through to the route plugin.
- `apps/api/test/helpers/test-app.ts` applies `PACKS_SCHEMA_SQL` on
  top of the existing v1 schema with the colliding `remote_object`
  block stripped (CQ-124 placeholder). The remaining v2 packs tables
  (`remote_pack`, `remote_pack_entry`, `receipt_pack_grant`,
  `pack_audit_state`, `pack_gc_state`) don't collide.
- `apps/api/test/v2/skeleton.test.ts` removes `UploadObjectPack`
  from the 501 set; only `SealPromotion` and `GetReceipt` remain
  unimplemented.
- `apps/api/test/v2/production-signer.test.ts` passes the new
  `transaction` dep alongside the existing `MemoryObjectStore`.
- New `apps/api/test/v2/sync/upload-object-pack.test.ts` covers 7
  cases: unauth 401, unknown promotion 404, cross-tenant 404 (I1),
  random bytes rejected by `verifyCasPack` 400, bad
  `x-prosa-pack-digest` header 400, happy path inserts 1
  `remote_pack` + 2 `remote_pack_entry` rows / writes the staging
  object / re-upload is `already_present` with row count unchanged,
  sealed/aborted refuses with 404. The happy path uses real
  `buildCasPack(...)` bytes so the test pin verifies the full Lane
  1 pack format end-to-end.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/upload-object-pack.test.ts`
  → pass, 7/7.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  67/67.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 202/203
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Slice 4 deferred (explicit):

- BeginPromotion still always returns `needs_inventory` for fresh
  bundles. The `needs_upload` transition requires reading the
  uploaded `inventory_object` segment, comparing the declared
  object set to `remote_pack_entry` rows, and emitting the missing
  set. That transition ships alongside the seal slice or its
  prerequisite.
- `SealPromotion` and `GET /v2/receipts/:receiptId` remain 501.
- CLI `prosa sync-v2`, resume/no-op behavior, and Docker E2E are
  pending downstream slices.

## Slice 5 (SealPromotion load-bearing transaction) — 2026-05-20

Scope:

- New `apps/api/src/v2/sync/seal-promotion.ts` implements
  `POST /v2/promotions/:promotionId/seal` — the only code path that
  writes `remote_authority_v2`, `search_generation_current`, or
  `receipt_pack_grant` (Lane 5 gate L5.6). Sequence:
  1. Resolve `promotion_staging` by `(id, tenant_id)`. Miss →
     `404 PROMOTION_NOT_FOUND`; `aborted` → 404;
     `materializing` → `409 SEAL_IN_PROGRESS`; `sealed` →
     idempotent re-read via `remote_authority_v2` ⨝ `receipt`.
  2. Verify both inventory segments are present in the object
     store at `staging/<tenant>/<promotion>/<segmentId>`. Missing
     → `409 INVENTORY_INCOMPLETE` with `missingSegmentIds[]`.
  3. CAS status flip `open|uploading → materializing` via
     `UPDATE … RETURNING id`. Losing the race → 409.
  4. Read uploaded pack digests from `promotion_uploaded_pack`
     (slice 4 maintains the linkage; this slice adds the
     `INSERT … ON CONFLICT DO NOTHING` in the upload path).
  5. Build a `PromotionReceiptV2Payload`. Counts come from
     `head_json`; `materialization.rowCountsByEntity` is zero for
     every canonical entity (projection materialization is
     deferred because CQ-124 still blocks the shared-name v2
     `projection_*` tables). `searchGenerationId` and
     `postgresCommitId` are derived deterministically from
     `(tenantId, storeId, bundleRoot)` so retries observe the
     same id.
  6. Call `deriveReceiptId(payload)` from `@c3-oss/prosa-types-v2`
     to set the canonical receipt id, then sign
     `receiptPayloadBytes(payload)` with the configured
     `ReceiptSigner`.
  7. One Postgres transaction: INSERT `receipt` + UPSERT
     `remote_authority_v2` + UPSERT `search_generation_current` +
     INSERT N `receipt_pack_grant` rows (`ON CONFLICT DO NOTHING`)
     + UPDATE `promotion_staging.status='sealed'`.
- New table `promotion_uploaded_pack(promotion_id, tenant_id,
  pack_digest, uploaded_at)` in `PROMOTION_SCHEMA_SQL`. The
  upload-object-pack handler INSERTs `ON CONFLICT DO NOTHING` after
  every accepted or already-present pack so the seal can resolve
  the per-promotion pack set.
- `apps/api/src/v2/index.ts` and `apps/api/src/v2/promotion.ts`
  thread the v2 signer into the route deps. `PromotionRoutesDeps`
  now carries `signer: ReceiptSigner`. The route handler maps
  `SealPromotionNotFoundError → 404`, `SealPromotionInProgressError
  → 409 SEAL_IN_PROGRESS`, `SealPromotionInventoryIncompleteError →
  409 INVENTORY_INCOMPLETE` (with `missingSegmentIds`).
- `apps/api/vitest.config.ts` adds aliases for `@c3-oss/prosa-db-v2`,
  `@c3-oss/prosa-bundle-v2`, `@c3-oss/prosa-types-v2`, and
  `@c3-oss/prosa-wire-v2` so vitest picks up source changes
  immediately instead of stale `dist/` builds.
- `apps/api/test/helpers/test-app.ts` applies the
  `search_generation_current` table on its own (the full
  `SEARCH_SCHEMA_SQL` still collides with v1 via `search_doc`).
- `apps/api/test/v2/skeleton.test.ts` removes `SealPromotion` from
  the 501 set; only `GetReceipt` remains unimplemented.

New tests in `apps/api/test/v2/sync/seal-promotion.test.ts`
(7 cases):

1. unauth → 401 UNAUTHENTICATED.
2. unknown `promotionId` → 404 PROMOTION_NOT_FOUND.
3. missing inventories → 409 INVENTORY_INCOMPLETE with
   `missingSegmentIds`.
4. happy path: BeginPromotion → uploads → seal → 200. Receipt row
   count = 1; `remote_authority_v2.current_receipt_id` =
   receipt.payload.receiptId; `search_generation_current.receipt_id`
   matches; `receipt_pack_grant` row count = 1 with the right
   pack_digest; `promotion_staging.status = 'sealed'`.
5. idempotent re-seal: same `receiptId`, no row duplication.
6. cross-tenant seal attempt → 404 PROMOTION_NOT_FOUND (I1).
7. invariant I5: signature verifies against the JWKS publication
   via `node:crypto` `verify(null, receiptPayloadBytes(payload),
   publicKey, sigBytes)`.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/seal-promotion.test.ts`
  → pass, 7/7 (includes the I5 JWKS verification).
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  74/74.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 209/210
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Slice 5 deferred (explicit):

- Projection / search_doc row materialization remains deferred
  until CQ-124 (v1/v2 shared-name table collision) is resolved.
  The receipt currently records `rowCountsByEntity` all zero —
  invariants I2/I3/I4 (projection row presence, count parity,
  search visibility) are not yet enforced.
- `GET /v2/receipts/:receiptId` remains 501; clients today must
  pull the receipt from the seal response.
- CLI `prosa sync-v2`, resume/no-op behavior, and Docker E2E are
  pending downstream slices.

## Slice 6 (GetReceipt route) — 2026-05-20

Scope:

- New `apps/api/src/v2/sync/get-receipt.ts` implements
  `GET /v2/receipts/:receiptId`. Tenant-scoped lookup against the
  `receipt` table; returns `{ status: 'found', receipt }` with the
  stored payload + signature verbatim, or `{ status: 'not_found',
  receiptId }` with a 404 response code. Cross-tenant attempts are
  indistinguishable from "doesn't exist" (I1 — existence does not
  leak across tenants).
- `apps/api/src/v2/promotion.ts` dispatches `GetReceipt` to the
  new handler; the route surface is now fully implemented and the
  501 fallthrough is unreachable.
- `apps/api/test/v2/skeleton.test.ts` flips its 501 assertion: the
  test now pins that NO Lane 5 route returns 501. A future
  regression that re-introduces 501 on any route will fail this
  case immediately.

New tests in `apps/api/test/v2/sync/get-receipt.test.ts` (4 cases):

1. unauth → 401 UNAUTHENTICATED.
2. unknown `receiptId` → 404 with `code='RECEIPT_NOT_FOUND'`,
   `status='not_found'`, and the echoed `receiptId`.
3. cross-tenant attempt (tenant B requesting a receipt sealed by
   tenant A) → 404 RECEIPT_NOT_FOUND. Confirms existence does not
   leak across tenants (I1).
4. happy path: full BeginPromotion → uploads → seal → GET sequence
   returns 200 with the same payload + signature the seal response
   produced (`expect(getBody.receipt.payload).toEqual(sealBody
   .receipt.payload)` plus the same on the signature object).

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/get-receipt.test.ts`
  → pass, 4/4.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  78/78 across all Lane 5 slices.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 213/214
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Governor review caveat (2026-05-20):

- Slice 6 focused GetReceipt smoke was re-run and passed 4/4.
- Focused CLI WIP smoke
  `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote.test.ts`
  passed 3/3.
- Reviewer aggregate smoke
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` failed 77/78 with
  a timeout in the malformed-body BeginPromotion case; the same file passed 7/7
  in isolation. The recorded aggregate 78/78 gate is not accepted until a fresh
  aggregate run is green or the timeout is fixed/documented.
- GetReceipt happy-path tests prove tenant-scoped retrieval only. CQ-138 blocks
  Lane 5 acceptance until GetReceipt and CLI receipt handling validate request
  id, row/payload tuple, shared schema, JWKS signature, and the accepted
  device/user access policy.

Server scope summary at slice 6 close:

- All five Lane 5 routes implemented and tested:
  `BeginPromotion`, `UploadSegment`, `UploadObjectPack`,
  `SealPromotion`, `GetReceipt`.
- Invariants enforced server-side: I1 (tenant isolation —
  asserted on every route), I5 (receipt signature verifies
  against published JWKS — proven via `node:crypto` verify in the
  slice 5 test). I2/I3/I4 remain deferred behind CQ-124.

Lane 5 server scope deferred (explicit):

- Projection / search_doc materialization (blocked by CQ-124).
- `BeginPromotion` `needs_upload` transition (server still always
  returns `needs_inventory` for fresh bundles; the
  client-driven retry sequence still works because subsequent
  uploads succeed against the staging slot, but the spec's
  needs_inventory → needs_upload progression is approximated).
- Client side: CLI `prosa sync-v2`, resume / no-op behavior,
  receipt verification UI, retries, `--dry-run`/`--no-resume`/
  `--json` flags.
- Docker-backed E2E (postgres + minio + API + CLI sync) — Lane 5
  acceptance gate.
- Five 180s stabilization cycles after CLI + E2E close.

## Slice 7 (CLI promote client + sync-v2 command) — 2026-05-20

Scope:

- New `apps/cli/src/cli/v2/sync/promote.ts` implements
  `promoteBundleV2(client, input)` — a generic-HTTP-client function
  that drives the four-call protocol against a v2-capable
  prosa-api server:
  1. POST `/v2/promotions/begin` with the bundle head + inventory
     segment refs. `already_promoted` → return early.
  2. PUT `/v2/promotions/:id/segments/<obj-inv>` and
     `<proj-inv>` with the inventory bytes and
     `x-prosa-transport-hash` declarations.
  3. POST `/v2/promotions/:id/object-packs` for every object pack
     (one streamed body per pack, transport hash declared).
  4. POST `/v2/promotions/:id/seal`.
  - Returns `{ status: 'already_promoted', receipt } |
    { status: 'sealed', receipt, promotionId }`.
  - On any non-200 step, throws `PromoteV2Error` carrying the
    failing step (`begin`/`upload-segment`/`upload-pack`/`seal`),
    the HTTP status code, and the parsed response body.
- The `PromoteHttpClient` interface is intentionally generic — a
  function `(req) => Promise<{ statusCode, json() }>`. Tests adapt
  Fastify's `app.inject(...)` directly; the CLI command wraps
  `fetch`.
- New `apps/cli/src/cli/commands/sync-v2.ts` defines the
  `prosa sync-v2` CLI command with `--server`, `--token`,
  `--tenant`, `--store`, `--device`, `--bundle`, and `--json`
  flags. The command reads a bundle directory layout
  (`head.json` + `sync-v2.layout.json` pointing at inventory and
  pack files), builds the promote input, runs the client, and
  prints either a human-readable or JSON status line.
  `--no-resume`, `--dry-run`, and progress UI ship in follow-up
  slices.
- `apps/cli/src/cli/main.ts` registers `syncV2Command()` alongside
  the existing v1 `syncCommand()`.
- `apps/cli/vitest.config.ts` adds aliases for v2 workspace
  packages (`@c3-oss/prosa-db-v2`, `@c3-oss/prosa-bundle-v2`,
  `@c3-oss/prosa-types-v2`, `@c3-oss/prosa-wire-v2`) so CLI tests
  pick up source changes rather than stale `dist/` builds.
- `apps/cli/package.json` adds `@c3-oss/prosa-db-v2`,
  `@c3-oss/prosa-types-v2`, `@c3-oss/prosa-wire-v2`, and
  `@noble/hashes` as workspace dependencies.

New tests in `apps/cli/test/cli/v2/sync/promote.test.ts` (3 committed cases,
end-to-end via in-process Fastify inject — server + canonical
types + CLI client all exercised together):

1. happy path: full four-call sequence seals a fresh bundle, the
   returned receipt's signature verifies against the published
   JWKS via `node:crypto verify(...)` (invariant I5 end-to-end
   through the CLI client surface).
2. fast path: a second promotion of the same bundleRoot returns
   `{ status: 'already_promoted', receipt }` with the same
   receiptId as the first seal.
3. error reporting: corrupted pack bytes surface as a
   `PromoteV2Error` with `step='upload-pack'` and
   `statusCode=400`.

Gates:

- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote.test.ts`
  → pass, 3/3.
- `pnpm --filter @c3-oss/prosa test` → pass, 289/290
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa-api test` → pass, 213/214
  (no regressions from CLI changes).
- `pnpm lint` → clean, 13/13 packages.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Governor review caveat (2026-05-20):

- Current WIP extends the CLI test to 4 cases and adds
  `GET /v2/promotions/:promotionId/status` tests. Focused smokes passed:
  `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote.test.ts`
  -> 4/4, and
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/get-promotion-status.test.ts`
  -> 5/5.
- The "I5 through the CLI client surface" evidence is test-side verification,
  not runtime CLI enforcement. CQ-138 remains open until the client validates
  every receipt with shared schema, tuple checks, receipt id derivation, JWKS
  lookup, and Ed25519 verification before returning success.
- Resume coverage currently proves one inventory skip only. It does not prove
  pack-skip resume, sealed checkpoint recovery, `--no-resume`, `--dry-run`,
  no-op under 2 seconds, command-level `prosa sync-v2`, or Docker E2E.
- CQ-139 blocks CLI acceptance because `sync-v2 --token` puts bearer tokens in
  argv.

Slice 7 deferred (explicit):

- Resume-after-interrupt checkpoints (slice 8).
- Adaptive upload concurrency (slice 9).
- Rich progress reporting / dry-run flag (slice 9).
- Docker-backed E2E (Lane 5 acceptance gate; runs the same
  promote client against a real Docker postgres + minio + API
  stack).
- Five 180s stabilization cycles after CLI + E2E close.

## Slice 8 (GetPromotionStatus + client resume) — 2026-05-20

Scope:

- New `apps/api/src/v2/sync/get-promotion-status.ts` implements
  `GET /v2/promotions/:promotionId/status`. Tenant-scoped lookup
  against `promotion_staging` joined with object-store
  `head(staging/<tenant>/<promotion>/<segmentId>)` lookups for each
  declared inventory segment, plus a SELECT of every uploaded pack
  digest from `promotion_uploaded_pack`. Returns
  `{ status, promotionId, bundleRoot, storeId, inventories: { object,
  projection }, uploadedPackDigests }`. Misses (including
  cross-tenant) produce 404 PROMOTION_NOT_FOUND so existence does
  not leak across tenants.
- `apps/api/src/v2/promotion.ts` adds the new route to
  `V2_PROMOTION_ROUTES` (6 routes now) and dispatches it. The
  skeleton contract test pins the expanded sorted list and op-name
  set.
- `apps/cli/src/cli/v2/sync/promote.ts` queries the status endpoint
  immediately after `BeginPromotion` and uses the response to skip
  re-uploading bytes the server already has: an inventory PUT is
  omitted when `inventories.<kind>.uploaded === true`, and a pack
  POST is omitted when its wire BLAKE3 already appears in
  `uploadedPackDigests`. A status fetch failure is non-fatal — the
  client falls back to uploading every byte, and the server's
  per-route idempotency catches any duplicates.

New server tests in
`apps/api/test/v2/sync/get-promotion-status.test.ts` (5 cases):

1. unauth → 401 UNAUTHENTICATED.
2. unknown `promotionId` → 404 PROMOTION_NOT_FOUND.
3. cross-tenant lookup → 404 PROMOTION_NOT_FOUND (I1).
4. fresh staging slot → `status='open'`, both inventories
   `uploaded:false`, empty `uploadedPackDigests`.
5. partial upload → only the uploaded inventory flips to true,
   `uploadedPackDigests` lists exactly the one pack digest.

New client test in
`apps/cli/test/cli/v2/sync/promote.test.ts` (1 case, integrated
with the existing in-process Fastify inject suite):

- Half-interrupt scenario: drive `BeginPromotion` and a single
  inventory PUT outside `promoteBundleV2`, then re-invoke the
  client with the same input. A recording-client wrapper asserts
  the second invocation issues the status fetch, skips the
  already-uploaded inventory PUT, and proceeds with the remaining
  inventory + pack + seal calls. Final result is `sealed`.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/get-promotion-status.test.ts`
  → pass, 5/5.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → pass,
  83/83.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 218/219
  (1 pre-existing skip).
- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote.test.ts`
  → pass, 4/4 (3 prior + 1 resume).
- `pnpm --filter @c3-oss/prosa test` → pass, 290/291
  (1 pre-existing skip).
- `pnpm lint` → clean, 13/13 packages.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Slice 8 deferred (explicit):

- Runtime receipt/schema/JWKS/tuple validation remains blocked by CQ-138.
- Device/user authorization for promotion status remains blocked by CQ-127.
- Resume identity validation remains blocked by CQ-128: the current client skips
  inventory uploads based on `uploaded` booleans, while the status response does
  not include enough digest/size/ref data for a closed comparison.
- Pack-skip resume is not proven and is currently mismatched: status returns
  canonical CAS `pack_digest`, while the client compares against the transport
  BLAKE3 of pack bytes. Reviewer smoke showed the two values differ.
- Status-assisted inventory skip relies on object-store presence only; wrong
  stored metadata hash/size is still covered by CQ-134.
- Persistent `~/.config/prosa/promotions/<id>.json` checkpoint file
  + `--no-resume` CLI flag (slice 9). Today's resume relies on the
  server-side staging row + status endpoint; restart of the whole
  process re-runs `BeginPromotion` (which returns the same id from
  the idempotent staging-row lookup).
- Adaptive upload concurrency, dry-run, JSON progress (slice 9).
- Docker-backed E2E (acceptance gate).
- Five 180s stabilization cycles.
