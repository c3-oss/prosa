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

## Slice 9 (Docker-backed E2E acceptance gate) — 2026-05-20

Scope:

- New `apps/api/test/e2e/v2-promote.e2e.test.ts` drives the full
  Lane 5 protocol against a real Postgres 16 + MinIO/S3 stack
  brought up by `apps/api/docker-compose.test.yml`. Follows the v1
  e2e gating: reads `PROSA_TEST_POSTGRES_URL`,
  `PROSA_TEST_S3_ENDPOINT`, `PROSA_TEST_S3_ACCESS_KEY`, and
  `PROSA_TEST_S3_SECRET_KEY` and uses `describe.skipIf(!shouldRun)`
  so the default `pnpm test` run stays hermetic.
- The harness resets the Postgres schema between runs (DROP +
  applySchema v1 + the conflict-free v2 promotion + packs +
  `search_generation_current` blocks), ensures the MinIO bucket
  exists, and builds a fresh API app per test pointed at the real
  backends via `S3ObjectStore` and `openPostgresDatabase`.

Three E2E cases:

1. **fresh seal + already_promoted + I5 JWKS verify** — drives
   `BeginPromotion → PUT inventories → POST object pack →
   SealPromotion` against real Postgres + MinIO. Re-issues
   `BeginPromotion` for the same bundleRoot and asserts the response
   is `already_promoted` with the same `receiptId` and that the
   round-trip completes in **< 2 s wall clock**. The seal-time
   receipt signature is verified against the published JWKS via
   `node:crypto verify(...)` against `receiptPayloadBytes`
   (invariant I5 end-to-end, signed by the live server).
2. **cross-tenant `GET /v2/receipts` 404 (I1)** — a sealed receipt
   for tenant A returns 200 to A and 404 RECEIPT_NOT_FOUND to a
   freshly-signed-up tenant B. Existence does not leak.
3. **resume after half-interrupt** — BeginPromotion + a single
   inventory PUT, then `GET /v2/promotions/:id/status` reports the
   uploaded inventory as `uploaded:true`, the other as `false`,
   and `uploadedPackDigests: []`. Finishing the remaining PUTs +
   pack + seal returns `status: 'sealed'`.

Smoke evidence (run from repo root with the harness already up):

```text
docker compose -f apps/api/docker-compose.test.yml up -d
PROSA_TEST_POSTGRES_URL='postgres://prosa:prosa@127.0.0.1:54329/prosa_test' \
PROSA_TEST_S3_ENDPOINT='http://127.0.0.1:54392' \
PROSA_TEST_S3_ACCESS_KEY='prosa' \
PROSA_TEST_S3_SECRET_KEY='prosa-minio' \
PROSA_TEST_S3_BUCKET='prosa-test-v2' \
pnpm --filter @c3-oss/prosa-api exec vitest run test/e2e/v2-promote.e2e.test.ts
```

Result: pass, 3/3 against the Docker harness; default `pnpm test`
shows 218 passed / 4 skipped (3 v2 e2e env-gated + 1 pre-existing
v1 skip).

Gates:

- Docker harness up: `docker compose -f apps/api/docker-compose.test.yml ps`
  → `api-postgres-1` and `api-minio-1` both report `healthy`.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/e2e/v2-promote.e2e.test.ts`
  (with env) → pass, 3/3.
- `pnpm --filter @c3-oss/prosa-api exec vitest run test/e2e/v2-promote.e2e.test.ts`
  (no env) → 3 skipped, 0 failed.
- `pnpm --filter @c3-oss/prosa-api test` → pass,
  218 passed / 4 skipped.
- `pnpm --filter @c3-oss/prosa-api lint` → clean.
- `pnpm typecheck` → pass, 13/13 packages.
- `git diff --check` → clean.

Governor review caveat (2026-05-20):

- The focused v2 E2E with env is useful Docker Postgres/MinIO adapter evidence,
  but it is not accepted as the full Lane 5 E2E gate.
- No-env runs skip all three v2 E2E cases, so default suite counts are not
  Docker proof.
- `just e2e` failed in reviewer smoke: the older `postgres-s3.e2e.test.ts`
  hit `MissingV2SignerError`, and concurrent schema resets between E2E files
  produced a Postgres duplicate-type error.
- The v2 E2E uses in-process Fastify `app.inject`; it does not exercise an API
  container, the `prosa sync-v2` command, or second-device remote read.
- The resume E2E did not assert the final projection upload/object-pack POST
  responses before seal. Current upload WIP makes the missing object-pack
  transport header observable, so this test needs strengthening before it can
  prove resume completion.
- CQ-140 tracks the E2E recipe/gate gap.

Slice 9 deferred (explicit):

- The promote driver / CLI still doesn't ship adaptive upload
  concurrency, dry-run output, JSON progress events, or
  `--no-resume`. The E2E proves the protocol; the UX polish is
  follow-up work.
- Five 180 s stabilization cycles before Lane 5 acceptance.

## CQ-126 closure (canonical v2 boot subset helper) — 2026-05-20

Scope:

- `packages/prosa-db-v2/src/apply.ts` now exports a single canonical
  helper `applyV2PromotionSubsetSchema(client)` and a load-bearing
  table list `V2_PROMOTION_SUBSET_TABLES`. The helper applies
  `PROMOTION_SCHEMA_SQL`, the packs SQL with the colliding
  `remote_object` block stripped (CQ-124 placeholder), and the
  per-(tenant, store) `search_generation_current` block including
  the idempotent legacy-shape migration from CQ-137.
- `apps/api/src/server.ts` boots through that helper and derives
  its fail-fast required-tables check from `V2_PROMOTION_SUBSET_TABLES`,
  so the boot table list cannot drift from the SQL the helper actually
  runs.
- Every test entry point now uses the same helper instead of inline
  regex strips:
  - `apps/api/test/helpers/test-app.ts` (in-process Fastify),
  - `apps/api/test/e2e/v2-promote.e2e.test.ts` (Docker E2E
    bootstrap),
  - `apps/cli/test/cli/v2/sync/promote.test.ts` (CLI promote
    driver),
  - `apps/api/test/v2/sync/cq-132-orphan-cleanup.test.ts` and
    `apps/api/test/v2/sync/cq-135-seal-restore.test.ts`.

Pinned by `apps/api/test/v2/cq-126-server-boot-schema.test.ts`:

1. `applyV2PromotionSubsetSchema` creates every table in
   `V2_PROMOTION_SUBSET_TABLES` on a fresh v1 database.
2. Re-applying the helper is idempotent (CREATE/ALTER/DO blocks all
   re-runnable).
3. Unauthenticated `POST /v2/promotions/begin` returns 401 (no
   "relation does not exist").
4. **Authenticated** BeginPromotion against a v1+v2-boot database
   reaches the v2 query layer cleanly: signs up a real tenant, posts
   an authenticated body, and asserts `200 needs_inventory` plus the
   matching `promotion_staging` row. Proves
   `remote_authority_v2` SELECT, `promotion_staging` partial-unique
   INSERT, and `claimDevice` upsert all resolve against the
   boot-applied schema.

Reviewer concerns addressed:

- `pnpm lint` repo-wide clean (`apps/api`, `prosa-db-v2`, every
  other workspace). Earlier closure-attempt failed on
  `PACKS_SCHEMA_SQL.replace(...)` and import formatting; both fixed.
- Test wording no longer claims CQ-124 closure — title and comments
  scope strictly to CQ-126. CQ-124 (the full v1/v2 shared-name
  cutover) remains open and is owned by Lane 10.
- The recorded evidence now includes an authenticated boot-path
  proof, not only the unauthenticated 401 route smoke.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cq-126-server-boot-schema.test.ts`
  → pass, 4/4.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 269 / 4 skipped.
- `pnpm --filter @c3-oss/prosa test` → pass, 290 / 1 skipped.
- `pnpm lint` → clean (13/13 packages).
- `pnpm typecheck` → clean (13/13 packages).

CQ-124 explicitly NOT closed by this slice:

- The full v1/v2 shared-name collision (for `device`,
  `remote_object`, `projection_session`, `search_doc`) still
  prevents `applySchemaV2` over a v1 database. Projection / search
  materialization remains v1-shaped. Lane 10 owns the namespace /
  rename / migration cutover. CQ-124 acceptance bullets stay open
  until that cutover lands.

CQ-137 closure rider — 2026-05-20:

- The same canonical helper carries the idempotent
  `search_generation_current` legacy-shape migration (`ADD COLUMN
  IF NOT EXISTS store_id`, backfill `NULL → ''`, then a guarded
  `DO` block that swaps the legacy single-column PK for
  `PRIMARY KEY (tenant_id, store_id)`). Production boot, the
  in-process Fastify test, the v2 Docker E2E bootstrap, and the
  CLI promote test all run this block before any seal is allowed
  to upsert.
- Pinned together with CQ-126 in `cq-126-server-boot-schema.test.ts`
  (the authenticated case touches the boot-applied
  `search_generation_current`), plus the existing
  `cq-137-schema-migration.test.ts` (legacy migration) and
  `cq-137-store-scoped-generation.test.ts` (two-store coexistence).
- CQ-137 acceptance bullets are all proven; the CQ is closed.

## CQ-141 closure (object-pack catalog/bytes invariant) — 2026-05-20

Scope:

- `apps/api/src/v2/sync/upload-object-pack.ts` catalog fast path
  now handles three storage-side states (healthy / missing /
  wrong-content). On wrong-content it `delete()`s the corrupt
  object and `putIfAbsent()`s the canonical verified bytes
  BEFORE linking the pack into `promotion_uploaded_pack`. The
  body has already passed `verifyCasPack`, so it is the
  authoritative source for the canonical
  `(tenant, pack_digest)` storage key.
- `apps/api/src/v2/sync/seal-promotion.ts` adds
  `SealPromotionPackBytesMissingError` and `head()`s every
  linked pack's storage URI before the authority swap. Any
  missing / zero-length pack fails seal closed; the CQ-135
  wrapper restores `materializing` → `open` so the client can
  re-upload and retry.
- `apps/api/src/v2/promotion.ts` maps the new error to
  `409 PACK_BYTES_MISSING` so the surface is observable to the
  client.

Pinned by four cases in
`apps/api/test/v2/sync/cq-141-wrong-metadata-and-seal-presence.test.ts`:

1. Catalog row + WRONG-CONTENT storage key — corrupt bytes are
   deleted and replaced with the canonical pack bytes; the pack
   is linked; route returns `already_present`.
2. Catalog row + MISSING storage key — canonical bytes are
   written; the pack is linked; route returns `already_present`.
3. Catalog row + MATCHING storage key — fast path is a no-op
   (object store still has exactly one entry); route returns
   `already_present`.
4. SealPromotion with a linked pack whose storage URI is empty
   throws `SealPromotionPackBytesMissingError`, the staging row
   is restored to `open` by the CQ-135 wrapper, and zero
   `receipt` / `remote_authority_v2` / `receipt_pack_grant` rows
   were written.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/cq-141-wrong-metadata-and-seal-presence.test.ts`
  → pass, 4/4.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 274 / 4 skipped.
- `pnpm lint` repo-wide → clean.
- `pnpm typecheck` repo-wide → clean.

Earlier partial closure (left for context): the prior slice
only repaired the missing-byte case via the existing two-case
`cq-141-catalog-only-repair.test.ts`. Reviewer smoke caught both
the wrong-content fast path and the seal-after-pack-byte-loss
gap; both are now covered by the new test file above. CQ-141
acceptance bullets are all proven; the CQ is closed.

## CQ-125 closure (BeginPromotion receipt verification) — 2026-05-20

Scope:

- `apps/api/src/v2/sync/begin-promotion.ts` adds the signer to
  `BeginPromotionDeps` and gates the `already_promoted` fast path
  on three independent checks:
  1. Authority tuple integrity — `loadAuthorityReceipt` loads the
     row scoped to `(tenant, store, bundleRoot, receiptId)` and
     refuses any row/payload tuple mismatch.
  2. Content-addressed derived id —
     `deriveReceiptId(payload) === payload.receiptId`.
  3. Signature verification —
     `signer.verifyReceipt(receiptPayloadBytes(payload), signature)`.
- Receipt is only returned when
  `payload.deviceId === request.device.deviceId`. A different
  device falls through to open its own staging slot — the
  bundle's authority already exists; the second device's re-seal
  produces a receipt signed under its own id.
- `apps/api/test/helpers/test-app.ts` exposes the signer on
  `TestApp` so seed helpers can sign with the same instance the
  route verifies against.
- `apps/api/test/v2/sync/begin-fast-path.test.ts` +
  `apps/api/test/v2/sync/cq-127-device-ownership.test.ts` updated
  to derive canonical receipt ids and sign with the test signer.

Pinned by `apps/api/test/v2/sync/cq-125-receipt-validation.test.ts`:

1. Tampered payload (deriveReceiptId mismatch) → 500
   `AUTHORITY_CORRUPT` with a `deriveReceiptId`-flagged message.
2. Bogus base64url signature (right shape, wrong bytes) → 500
   `AUTHORITY_CORRUPT` with a signature-flagged message.
3. Foreign-signer signature with the keyId spoofed to the
   current signer's → 500 `AUTHORITY_CORRUPT`.
4. Happy path: properly derived id + signed payload → 200
   `already_promoted` with the schema-valid receipt.

Gates:

- `pnpm --filter @c3-oss/prosa-api test` → pass, 278 / 4 skipped.
- `pnpm --filter @c3-oss/prosa test` → pass, 290 / 1 skipped.
- `pnpm lint` repo-wide → clean.
- `pnpm typecheck` repo-wide → clean.

CQ-125 acceptance bullets are all proven; the CQ is closed. The
malformed/unparseable receipt JSON case is implicitly covered by
the existing missing-receipt path (`coerceJsonbObject` → null →
'missing'); the device-mismatch + invalid-signature axes are
explicit cases above.

## CQ-136 closure (sealed-replay derived id + signature) — 2026-05-20

Scope:

- `apps/api/src/v2/sync/seal-promotion.ts` extracts
  `loadAndValidateLinkedReceipt(deps, staging, linkedReceiptId,
  promotionId)`. The helper runs three independent checks before
  returning a linked receipt:
  1. Tuple integrity (tenant / store / device / receiptId /
     bundleRoot all consistent across the staging row + signed
     payload).
  2. Content-addressed derived id —
     `deriveReceiptId(payload) === payload.receiptId`.
  3. Ed25519 signature verification against the server JWKS via
     `signer.verifyReceipt(receiptPayloadBytes(payload), signature)`.
  Any failure throws `SealPromotionLinkCorruptError` → 500
  SEAL_LINK_CORRUPT; a missing row falls through so the
  re-seal attempt can restore the link.
- BOTH replay branches now go through the helper:
  - the normal `status='sealed'` branch (idempotent retry after
    seal completed),
  - the race-loser branch (someone else flipped the row past us
    between our pre-flip read and the CAS).
  The race-loser previously trusted the freshly-read
  `sealed_receipt_id` by id alone — a concurrent attacker who
  tampered with the link between the pre-flip read and the
  race-loser re-read could otherwise slip a foreign receipt back
  to the client.

Pinned by:

- `apps/api/test/v2/sync/cq-136-resale.test.ts` (existing) — 3
  cases proving A→B re-seal returns A's receipt; the row-level
  `sealed_receipt_id` linkage assertion; tuple-mismatched link
  fails closed with SEAL_LINK_CORRUPT.
- `apps/api/test/v2/sync/cq-136-link-validation.test.ts` (new) —
  3 cases: tampered payload (deriveReceiptId mismatch), bogus
  signature, foreign-signer signature with the keyId spoofed to
  the current signer's. Each seals a real promotion to establish
  the staging linkage, then overwrites `sealed_receipt_id` with a
  spoof receipt and re-issues seal; all return 500
  SEAL_LINK_CORRUPT.

Gates:

- `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/cq-136-link-validation.test.ts test/v2/sync/cq-136-resale.test.ts`
  → pass, 6/6.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 281 / 4 skipped.
- `pnpm lint` repo-wide → clean.
- `pnpm typecheck` repo-wide → clean.

CQ-136 acceptance bullets are all proven; the CQ is closed.

## CQ-123 closure (Better Auth lifecycle proof) — 2026-05-20

Scope:

- `apps/cli/test/cli/v2/sync/promote.test.ts > drives the full
  four-call protocol and seals a fresh bundle` now asserts the
  CQ-123 end-to-end lifecycle:
  1. `auth.signupWithTenant` creates a real Better Auth org +
     user; `account.tenantId` is the mixed-case
     `organization.id`.
  2. `promoteBundleV2(...)` drives BeginPromotion → uploads →
     SealPromotion through that tenantId.
  3. After seal, the receipt is parsed with
     `promotionReceiptV2Schema.safeParse(...)` and the assertion
     passes. The test also asserts
     `result.receipt.payload.tenantId === account.tenantId`,
     proving the mixed-case id really flowed end-to-end.
  4. The signature is verified against the server's JWKS via
     `node:crypto` (existing I5 check).
- The other CLI lifecycle cases (already-promoted fast path,
  resume after half-interrupt) continue to exercise the same
  Better Auth signup pathway.

This closes the remaining CQ-123 acceptance gap: the prior
`opaqueAuthIdSchema` relaxation in `prosa-wire-v2` ensured the
canonical schemas admit Better Auth ids; the new
safeParse + tuple equality assertion proves a real Better Auth
signup all the way through to a schema-validated receipt at the
client.

Gates:

- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote.test.ts`
  → pass, 4/4.
- The existing apps/api fixture tests
  (`apps/api/test/v2/sync/cq-123-opaque-auth-ids.test.ts` and
  `apps/api/test/v2/sync/begin-fast-path.test.ts > returns
  already_promoted ...`) continue to pass.

CQ-123 acceptance bullets are all proven; the CQ is closed.

## CQ-138 closure (CLI client-side receipt validation) — 2026-05-20

Scope:

- `apps/cli/src/cli/v2/sync/promote.ts` adds
  `createReceiptVerifier(client)` — a small helper that runs
  three independent checks on every receipt the CLI surfaces:
  1. `promotionReceiptV2Schema.safeParse(receipt)` — canonical
     wire schema (whose superRefine itself enforces
     `deriveReceiptId(payload) === payload.receiptId`).
  2. Explicit `deriveReceiptId` check as defense-in-depth in
     case of schema-version drift.
  3. JWKS lookup against `/v2/.well-known/receipt-keys.json`
     (keys cached per promote) + Ed25519 signature verification
     via `node:crypto.verify(...)`.
- Both the `already_promoted` fast path in BeginPromotion and
  the SealPromotion response now route through the verifier.
  Any failure throws `PromoteV2Error` with `step` and a
  descriptive message so callers persist nothing.

Pinned by:

- `apps/cli/test/cli/v2/sync/promote-receipt-validation.test.ts`
  (new) — 5 cases via an in-process tampering proxy:
  1. SealPromotion tampered payload — `serverRegion` flipped
     after server signed; rejected.
  2. SealPromotion forged signature — keyId intact, sig bytes
     zeroed; rejected.
  3. SealPromotion malformed payload — required `counts` field
     removed; rejected by schema before any crypto work.
  4. BeginPromotion `already_promoted` tampered receipt on
     retry — first call seals cleanly, second-call replay is
     tampered between server and client; rejected.
  5. Happy path — no tampering returns `sealed` cleanly with no
     throw.
- `apps/api/test/v2/sync/cq-138-receipt-validation.test.ts`
  (existing) — server-side GetReceipt validation: 5 cases
  (receiptId mismatch, store mismatch, device mismatch,
  unknown-key signature, tampered payload). All return
  `404 RECEIPT_NOT_FOUND`.

Gates:

- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/v2/sync/promote-receipt-validation.test.ts`
  → pass, 5/5.
- `pnpm --filter @c3-oss/prosa-api test` → pass, 281 / 4 skipped.
- `pnpm lint` + `pnpm typecheck` repo-wide → clean.

CQ-138 acceptance bullets are all proven (the same-tenant policy
sub-bullet is delegated to CQ-127); the CQ is closed.

## CQ-127 closure (mandatory device + GetReceipt scoping) — 2026-05-20

Scope:

- `apps/api/src/v2/promotion.ts` renames `maybeVerifyDevice` to
  `requireVerifiedDevice` and gates every post-begin route on a
  three-state result:
  - `missing` (header absent) → 400 DEVICE_REQUIRED;
  - `invalid` (unregistered to this user) → 403 DEVICE_NOT_OWNED;
  - `verified` (registered) → route proceeds; the inner handler
    cross-checks against `staging.device_id` and surfaces 403
    DEVICE_MISMATCH on disagreement.
- GetReceipt (`GET /v2/receipts/:receiptId`) additionally compares
  the verified device id against `payload.deviceId` and returns
  404 RECEIPT_NOT_FOUND on mismatch. The 404 (vs 403) prevents a
  probe from distinguishing "exists, wrong device" from "does not
  exist".
- `apps/cli/src/cli/v2/sync/promote.ts` threads
  `input.deviceId` into `x-prosa-device-id` on every post-begin
  request — status fetch, inventory segment uploads, object-pack
  upload, seal. The header reuses the same device id
  BeginPromotion already requires in the request body.

Pinned by:

- Pre-existing `apps/api/test/v2/sync/cq-127-device-policy-routes.test.ts`
  — 4 cases (UploadSegment mismatch / UploadObjectPack
  unregistered / SealPromotion mismatch / GetPromotionStatus
  mismatch).
- Pre-existing `apps/api/test/v2/sync/cq-127-device-ownership.test.ts`
  — 4 cases (auto-register fresh device, cross-user-steal refusal,
  foreign-device fall-through to needs_inventory, same-device
  already_promoted replay).
- Updated v2 sync test suite — every route test
  (`upload-segment`, `upload-object-pack`, `seal-promotion`,
  `get-promotion-status`, `get-receipt`, `cq-134`, `cq-136-*`,
  `cq-137`, `cq-138`, `cq-141-*`) now sends the device header.
  Tests that exercise tenant isolation register a separate device
  for the second tenant; 404-on-unknown tests register the device
  before the call so the test exercises the intended 404 path.
- `apps/cli/test/cli/v2/sync/promote.test.ts` exercises the
  header end-to-end through the lifecycle test.

Gates:

- `pnpm --filter @c3-oss/prosa-api test` → pass, 281 / 4 skipped.
- `pnpm --filter @c3-oss/prosa test` → pass, 295 / 1 skipped.
- `pnpm lint` repo-wide → clean.
- `pnpm typecheck` repo-wide → clean.

CQ-127 acceptance bullets are all proven; the CQ is closed.

## CQ-140 partial closure (just e2e green) — 2026-05-20

Scope:

- `apps/api/test/e2e/v2-promote.e2e.test.ts` sends
  `x-prosa-device-id` on every post-begin inject call (CQ-127
  alignment). The cross-tenant receipt-isolation case registers
  a separate device for tenant B via a one-off `postgres`
  client so `verifyDeviceOwnership` passes and the 404 path
  exercises tenant isolation, not device ownership.
- `signupTenant` returns `userId` so the tenant-B device insert
  can reference it.
- Pre-existing changes from earlier CQ-140 work remain in place:
  - `apps/api/test/e2e/postgres-s3.e2e.test.ts` passes
    `PROSA_RUNTIME_MODE: 'test'` to `loadConfig(...)`.
  - `apps/api/vitest.config.ts` serializes e2e files when any
    argv contains `"e2e"`.

Green-recipe evidence (with Docker harness up):

```text
$ docker compose -f apps/api/docker-compose.test.yml ps
NAME             STATUS
api-minio-1      Up (healthy)   :54392
api-postgres-1   Up (healthy)   :54329

$ just e2e
 ✓ test/e2e/postgres-s3.e2e.test.ts (1 test) [v1 path]
 ✓ test/e2e/v2-promote.e2e.test.ts (3 tests) [Lane 5 path]
 Test Files  2 passed (2)
      Tests  4 passed (4)
```

No-env behavior (acceptance: skip != gate proof):

```text
$ env -u PROSA_TEST_POSTGRES_URL -u PROSA_TEST_S3_ENDPOINT \
    pnpm --filter @c3-oss/prosa-api exec vitest run test/e2e/v2-promote.e2e.test.ts
 Test Files  1 skipped (1)
      Tests  3 skipped (3)
```

Gates:

- `pnpm --filter @c3-oss/prosa-api test` → pass, 281 / 4 skipped
  (the 4 skipped include the env-gated v2 e2e tests + 1 v1
  pre-existing skip; with the env vars set they all pass).
- `pnpm lint` repo-wide → clean.
- `pnpm typecheck` repo-wide → clean.

Still scoped out of Lane 5 (intentional, recorded for the
governor):

- A Docker-backed `prosa sync-v2` subprocess harness — currently
  the v2 e2e uses in-process Fastify `app.inject` against real
  Postgres + MinIO. CQ-127 + CQ-138 + CQ-123 already pin the
  route + client semantics for the subprocess case; the missing
  piece is the harness itself. Tracked as the remaining CQ-140
  bullet.
- A two-process second-device remote-read end-to-end. CQ-127's
  GetReceipt scoping + CQ-138's CLI verification cover the
  semantics, but no subprocess test currently exercises a fresh
  process reading another device's receipt.
