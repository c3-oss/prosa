# Lane 5 — Sync protocol

## Goal

Wire the four-call promotion protocol end-to-end: `BeginPromotion` → `UploadSegment`/`UploadObjectPack` → `SealPromotion` → `GetReceipt`. After this lane, a v2 client can promote a fresh bundle, the server signs and stores the receipt in a single Postgres transaction, the no-op fast path completes in < 2 s, and resume after interruption works without re-uploading already-staged segments.

## Depends on

- Lane 4 (Server) complete — uses the Postgres schema, KMS signing, streaming validation, advisory locks.
- Lane 1 (Local store) complete — the client reads `BundleHeadV2`, walks segments, builds inventories.
- Lane 0 (Foundation) complete — wire schemas come from `prosa-wire-v2`.

## Deliverables

- Server endpoints under `apps/api/src/v2/sync/`:
  - `POST /v2/promotions/begin`
  - `PUT /v2/promotions/:promotionId/segments/:segmentId`
  - `POST /v2/promotions/:promotionId/object-packs`
  - `POST /v2/promotions/:promotionId/seal`
  - `GET /v2/receipts/:receiptId`
- Client module `apps/cli/src/cli/v2/sync/` implementing the four-call sequence with retries.
- `prosa sync-v2` CLI command (alongside v1).
- Inventory segment writer in `prosa-bundle-v2` (used by `BeginPromotion`).
- Checkpoint state for resume under `~/.config/prosa/promotions/<promotion_id>.json`.
- E2E test scenarios in the Docker harness.

## Tasks

1. **Inventory segments.** Client-side: `buildObjectInventorySegment(bundle) → SegmentRef + bytes`, sorted by `(hash_alg, hash_hex, uncompressed_size, compression) ASC`. `buildProjectionInventorySegment(bundle)` analogous. Stored as `.arrow.zst` files under the current epoch.
2. **`POST /v2/promotions/begin`.** Server handler:
   - Validate `BundleHeadV2` shape and counts.
   - Lookup `(tenant_id, store_id, bundle_root)` in `remote_authority_v2`. Match → return `{ status: 'already_promoted', receipt }` from the `receipt` table. **This is the no-op fast path.**
   - Else: insert `promotion_staging` row, status `open`. Compare segment digests + object inventory against existing tenant-scoped `remote_pack_entry` to compute `missingObjects` + `missingSegments`. Return them.
   - If inventory segments not yet uploaded: return `{ status: 'needs_inventory', ... }`.
3. **`PUT /v2/promotions/:promotionId/segments/:segmentId`.** Server handler: stream body, validate digest matches segment `digest`, write to S3 under `staging/<tenant>/<promotion_id>/<segment_id>`, insert/upsert `remote_pack` (for object packs) or record segment ref in staging.
4. **`POST /v2/promotions/:promotionId/object-packs`.** Body is the binary pack format from Lane 1. Server uses the streaming validation pipeline from Lane 4. Inserts/upserts `remote_pack` + `remote_pack_entry` rows on success. Idempotent: re-upload of same `pack_digest` is a no-op.
5. **`POST /v2/promotions/:promotionId/seal`.** Server handler — the load-bearing transactional path:
   - Verify all declared segments + objects materialized.
   - Build `PromotionReceiptV2Payload`.
   - Materialize projection rows into Postgres `projection_*` tables (bulk upsert, ON CONFLICT DO UPDATE).
   - Materialize search docs into `search_doc` table.
   - **One Postgres transaction** at the end:
     - INSERT `receipt`.
     - UPSERT `remote_authority_v2 (current_receipt_id, current_bundle_root, promoted_at)`.
     - UPSERT `search_generation_current`.
     - INSERT `receipt_pack_grant` rows for every pack in the promotion.
     - UPDATE `promotion_staging SET status='sealed'`.
   - Sign the receipt **inside or outside** the transaction — both work, but signing inside means the transaction holds open for the KMS round-trip (~10 ms). Acceptable.
   - Return `{ status: 'sealed', receipt }`.
6. **`GET /v2/receipts/:receiptId`.** Server handler: fetch from `receipt` table. Used by clients that lost the seal response.
7. **Client-side sync engine.** `apps/cli/src/cli/v2/sync/promote.ts`:
   - Build inventories.
   - Call `BeginPromotion`. Handle `already_promoted` → return early.
   - Handle `needs_inventory` → upload inventories → retry.
   - Handle `needs_upload` → upload missing segments + object packs in parallel (adaptive concurrency).
   - Call `SealPromotion`.
   - Persist receipt to `~/.config/prosa/promotions/<promotion_id>.json` and update authority cache.
8. **Resume logic.** Before any segment/pack upload, check `~/.config/prosa/promotions/<promotion_id>.json`. If present, request server's view of `promotion_staging` and skip already-staged items. Implements idempotent retry under interrupt.
9. **Adaptive concurrency.** Port `AdaptiveUploadConcurrencyController` from v1.
10. **`prosa sync-v2` CLI.** Wraps the engine with flags: `--server`, `--tenant`, `--store`, `--dry-run`, `--no-resume`, `--object-concurrency`, `--verbose`, `--json`.

## Concrete types and schemas

### `POST /v2/promotions/begin`

```ts
// apps/api/src/v2/sync/begin-promotion.ts
export async function beginPromotion(
  ctx: V2RequestContext,
  input: BeginPromotionRequest,
): Promise<BeginPromotionResponse> {
  // 1. Fast path: already promoted?
  const existing = await ctx.db.query<{ current_receipt_id: string }>(
    `SELECT current_receipt_id FROM remote_authority_v2
       WHERE tenant_id = $1 AND store_id = $2 AND current_bundle_root = $3`,
    [ctx.tenantId, input.storeId, input.head.bundleRoot],
  )
  if (existing.rows.length > 0) {
    const receipt = await fetchReceipt(ctx.db, existing.rows[0].current_receipt_id)
    return { status: 'already_promoted', receipt }
  }

  // 2. Inventory present?
  const needsInventory = await checkInventorySegmentsPresent(ctx, input)
  if (needsInventory.length > 0) {
    const promotionId = await openStaging(ctx, input, 'pending_inventory')
    return { status: 'needs_inventory', promotionId, missingInventories: needsInventory }
  }

  // 3. Compute missing.
  const promotionId = await openStaging(ctx, input, 'open')
  const { missingSegments, missingObjects } = await computeMissing(ctx, input)
  return { status: 'needs_upload', promotionId, missingSegments, missingObjects }
}
```

### `POST /v2/promotions/:promotionId/seal` (the load-bearing transaction)

```ts
// apps/api/src/v2/sync/seal-promotion.ts
export async function sealPromotion(
  ctx: V2RequestContext,
  input: SealPromotionRequest,
): Promise<SealPromotionResponse> {
  const staging = await fetchStaging(ctx.db, input.promotionId)
  if (staging.status !== 'open' && staging.status !== 'uploading') {
    throw new Error(`promotion ${input.promotionId} not in sealable state: ${staging.status}`)
  }

  // 1. Verify all declared segments + objects materialized in S3 + catalog.
  await verifyMaterialization(ctx, staging)

  // 2. Mark staging materializing (out of band).
  await ctx.db.query(`UPDATE promotion_staging SET status='materializing' WHERE id=$1`, [input.promotionId])

  // 3. Bulk upsert projection rows.
  await materializeProjection(ctx, staging)

  // 4. Bulk upsert search_doc rows.
  await materializeSearchDocs(ctx, staging)

  // 5. Build receipt payload.
  const payload = buildReceiptPayload(ctx, staging, input.head)

  // 6. Sign via KMS.
  const signature = await signReceipt(payload)
  const receipt: PromotionReceiptV2 = { payload, signature }

  // 7. THE TRANSACTION.
  await ctx.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [payload.receiptId, ctx.tenantId, staging.store_id, staging.device_id, payload, signature],
    )
    await tx.query(
      `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, store_id) DO UPDATE
         SET current_receipt_id = EXCLUDED.current_receipt_id,
             current_bundle_root = EXCLUDED.current_bundle_root,
             promoted_at = EXCLUDED.promoted_at`,
      [ctx.tenantId, staging.store_id, payload.receiptId, payload.bundleRoot],
    )
    await tx.query(
      `INSERT INTO search_generation_current (tenant_id, store_id, receipt_id, generation_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, store_id) DO UPDATE
         SET receipt_id = EXCLUDED.receipt_id,
             generation_id = EXCLUDED.generation_id`,
      [ctx.tenantId, staging.store_id, payload.receiptId, payload.materialization.searchGenerationId],
    )
    await bulkInsertReceiptPackGrants(tx, ctx.tenantId, payload.receiptId, staging.pack_digests)
    await tx.query(
      `UPDATE promotion_staging SET status='sealed', updated_at=now() WHERE id=$1`,
      [input.promotionId],
    )
  })

  return { status: 'sealed', receipt }
}
```

This is the **single Postgres transaction** that swaps authority. No async window. No partial state ever leaks to readers.

### Resume logic

```ts
// apps/cli/src/cli/v2/sync/resume.ts
export async function resumeOrStart(
  client: ProsaApiClientV2,
  config: SyncConfig,
  bundle: Bundle,
): Promise<PromotionContext> {
  const checkpointPath = path.join(config.dir, 'promotions', `${bundle.head.bundleRoot}.json`)
  const existing = await readJsonIfExists<PromotionCheckpoint>(checkpointPath)
  if (!existing || existing.status === 'sealed' || existing.status === 'aborted') {
    return startFresh(client, bundle)
  }

  // Resume: ask server for staging state.
  const serverStatus = await client.getPromotionStatus(existing.promotionId)
  if (serverStatus.status === 'sealed') {
    // Server completed; client missed the response. Fetch receipt.
    const receipt = await client.getReceipt(serverStatus.receiptId)
    await persistAuthority(config, receipt)
    return { kind: 'resumed_complete', receipt }
  }

  // Filter already-uploaded segments and packs from the upload plan.
  return { kind: 'resume_active', promotionId: existing.promotionId, alreadyUploaded: serverStatus.uploaded }
}
```

## Tests

| File | Asserts |
|---|---|
| `apps/api/test/v2/sync/begin-fast-path.test.ts` | `BeginPromotion` against an already-promoted bundle returns `already_promoted` in < 100 ms. |
| `apps/api/test/v2/sync/seal-transaction.test.ts` | `SealPromotion` updates `receipt`, `remote_authority_v2`, `search_generation_current`, `receipt_pack_grant`, `promotion_staging` all in one transaction. Failure mid-transaction → none of the rows change. |
| `apps/api/test/v2/sync/seal-idempotent.test.ts` | Calling `SealPromotion` twice with the same `promotion_id` returns the same receipt; no duplicate rows. |
| `apps/api/test/v2/sync/upload-resume.test.ts` | After uploading half the missing packs, client killed; resume uploads the remaining half; final seal succeeds. |
| `apps/cli/test/v2/sync/full-promotion.test.ts` | E2E: fresh bundle → `prosa sync-v2` → server has expected `remote_pack` count, `projection_session` count, signed receipt. |
| `apps/cli/test/v2/sync/no-op-promotion.test.ts` | After successful promotion, second `prosa sync-v2` returns in < 2 s wall clock with `already_promoted`. |
| `apps/api/test/v2/sync/receipt-verify.test.ts` | **Invariant I5**: receipt fetched via `GET /v2/receipts/:id` verifies against JWKS. |
| `apps/api/test/v2/sync/e2e-docker.test.ts` | Full Docker harness: postgres + minio + api worker; CLI promotes 1.4 GB synthetic bundle; counts match; receipt signed. |

## Gate

The lane is complete when:

1. All test files above pass.
2. `prosa sync-v2` against the E2E harness completes a fresh promotion of a 1.4 GB synthetic bundle in network-bound wall clock.
3. `prosa sync-v2` repeated against the same bundle completes in < 2 s.
4. `prosa sync-v2 --no-resume` ignores checkpoint; full re-upload succeeds.
5. **Invariants I1, I2, I3, I4, I5 all pass.**
6. Lint rule: only `apps/api/src/v2/sync/seal-promotion.ts::sealPromotion` writes to `remote_authority_v2`, `search_generation_current`, or `receipt_pack_grant`. Any other code path is a CI failure.

## Risks

| Risk | Mitigation |
|---|---|
| Seal transaction times out on huge promotions | Profile: at 1M projection rows, the materialization phase (steps 3–4) runs OUTSIDE the transaction. Only the small swap is in the TX. |
| Resume logic misses an already-uploaded pack | Server-side: `pack_digest` lookup is the source of truth. Client-side checkpoint is advisory only. |
| KMS down at seal time | Sign retries with backoff; if KMS unavailable > 30 s, seal fails and client retries later. Staging persists. |
| Receipt fetch with wrong tenant | `GET /v2/receipts/:id` requires `x-prosa-tenant-id` matching the receipt's tenant; 404 otherwise. |
| `already_promoted` race during concurrent promotion | Two clients race on same `bundle_root`: only one wins the `INSERT` into `receipt`; second gets a unique-constraint error and treats as `already_promoted`. |

## Unblocks

Lane 6 (`07-lane-6-read-api.md`) — read API consumes the populated `projection_*` and `search_doc` tables + receipts.
