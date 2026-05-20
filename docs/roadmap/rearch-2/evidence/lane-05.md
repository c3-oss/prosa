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
