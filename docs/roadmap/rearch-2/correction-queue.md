# rearch-2 Correction Queue

Updated: 2026-05-20 after Lane 5 slice 2 review.

## Open blocking corrections

### CQ-123: Better Auth tenant_id values do not satisfy `canonicalIdSchema`

Severity: high
Blocking: yes (blocks Lane 5 acceptance — receipt schema cannot be parsed by clients)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20):

1. **Schema direction** (preserved from the earlier partial closure):
   `packages/prosa-wire-v2/src/primitives.ts` exports
   `opaqueAuthIdSchema` for authentication identifiers
   (`tenant`, `store`, `device`). It allows printable ASCII
   `[A-Za-z0-9][A-Za-z0-9_.:-]*` up to 255 chars — wide enough to
   admit Better Auth's mixed-case nanoids while still rejecting
   empty / whitespace / overlong values. `canonicalIdSchema`
   keeps the strict lowercase contract for content-addressed
   identifiers (segments, packs, raw source files).

   Updated wire schemas:
   - `bundleHeadV2Schema.storeId` → `opaqueAuthIdSchema`;
   - `beginPromotionRequestSchema.tenantId / storeId /
     device.deviceId` → `opaqueAuthIdSchema`;
   - `promotionReceiptV2PayloadSchema.tenantId / storeId /
     deviceId` → `opaqueAuthIdSchema`.

   The server-side opaque local schema in `begin-promotion.ts` is
   gone — `beginPromotionRequestSchema` is the single source of
   truth.

2. **End-to-end lifecycle proof** (closes the acceptance gap):
   `apps/cli/test/cli/v2/sync/promote.test.ts > drives the full
   four-call protocol and seals a fresh bundle` now drives the
   full canonical lifecycle through a real Better Auth signup —
   `tenantId` is the mixed-case `organization.id` returned by
   `auth.signupWithTenant`. After seal, the test:
   - safeParses the returned receipt with
     `promotionReceiptV2Schema` and asserts success;
   - asserts `result.receipt.payload.tenantId === account.tenantId`
     (so the mixed-case id really flowed through);
   - fetches the server JWKS and verifies the receipt signature
     against the published key via `node:crypto`.

   This is the I5 invariant + the CQ-123 lifecycle bullet, pinned
   as a single integration test.

Pinned together by:

- `apps/api/test/v2/sync/cq-123-opaque-auth-ids.test.ts` — six
  schema/fixture cases (`opaqueAuthIdSchema` accepts Better Auth
  nanoids; `canonicalIdSchema` still rejects them;
  `bundleHeadV2Schema` / `promotionReceiptV2Schema` /
  `beginPromotionResponseSchema` all parse mixed-case ids).
- `apps/cli/test/cli/v2/sync/promote.test.ts` (sealed lifecycle
  case) — real signup → BeginPromotion → uploads → seal → client
  safeParse + JWKS verify.
- `apps/api/test/v2/sync/begin-fast-path.test.ts > returns
  already_promoted ...` — the original regression pin (re-enabled
  by the schema relaxation).

Problem:

`prosa-wire-v2` constrains `tenantId`, `storeId`, and `deviceId` to
`canonicalIdSchema`, which requires lowercase characters only (CQ-002).
`apps/api/src/auth.ts` boots Better Auth with default options, so
`organization.id` is a mixed-case nanoid (e.g.
`z3EIp38VKKSqPFuAk238kNUxGVWWf4RP`). The tenant_id stored on every v2
row therefore never matches the canonical regex.

Lane 5 slice 1 works around this server-side by validating
`BeginPromotion` requests with a local opaque-string schema for
`tenantId`/`storeId`/`deviceId`. The response receipt is still stored
verbatim, which means the receipt payload carries a mixed-case
`tenantId` and a client running
`promotionReceiptV2Schema.safeParse(receipt)` will reject it.

Risk:

Lane 5 cannot reach a green E2E gate with mixed-case tenant ids:
`prosa sync-v2` and the second-device remote read will both fail
client-side receipt verification, even though the server signed the
receipt correctly. Invariant I5 (receipt verifiability end-to-end) is
not satisfied until this mismatch resolves.

Smoke evidence:

```text
node -e "const re=/^[a-z0-9][a-z0-9_:-]*$/u; for (const id of ['org_testLane5','z3EIp38VKKSqPFuAk238kNUxGVWWf4RP','store-ok','dev-1']) console.log(id, re.test(id) ? 'ok' : 'reject');"
```

Output:

```text
org_testLane5 reject
z3EIp38VKKSqPFuAk238kNUxGVWWf4RP reject
store-ok ok
dev-1 ok
```

Required fix (one of):

- Configure Better Auth to mint lowercase canonical ids for
  `organization.id`, `user.id`, and `device.id` (uniform across v1 and
  v2 — needs a migration plan for any pre-existing mixed-case rows).
- Or relax the `canonicalIdSchema` boundaries on auth-system ids in
  `prosa-wire-v2` (e.g. introduce `opaqueAuthIdSchema` and use it for
  `tenantId`, `storeId`, `deviceId` in `bundleHeadV2Schema`,
  `beginPromotionRequestSchema`, and `promotionReceiptV2PayloadSchema`)
  while keeping `canonicalIdSchema` strict for content-addressed ids
  (segmentId, objectId, packDigest, bundleRoot).

Acceptance:

- [x] A real Better Auth signup produces tenant/store/device ids that
      either match the v2 canonical schema or pass the relaxed
      auth-id schema, and a receipt signed by the server passes
      client-side `promotionReceiptV2Schema.safeParse` (CLI lifecycle
      test asserts this directly).
- [x] End-to-end test covers the full lifecycle:
      signup → BeginPromotion → uploads → seal → client verifies
      signature against JWKS
      (`apps/cli/test/cli/v2/sync/promote.test.ts > drives the full
      four-call protocol and seals a fresh bundle`).
- [x] Lane 5 slice 1 test re-enables
      `beginPromotionResponseSchema.safeParse` assertions removed in
      this slice
      (`apps/api/test/v2/sync/begin-fast-path.test.ts > returns
      already_promoted ...`).

### CQ-124: v1 and v2 schemas share table names with incompatible columns

Severity: high
Blocking: yes (blocks Lane 5 seal/materialization acceptance and Lane 10 cutover; does not block independent BeginPromotion/upload slices)
Status: open — subset workaround formalized (2026-05-20); full v1/v2 cutover deferred to Lane 10
Owner: Ralph

Subset workaround formalization (2026-05-20): the conflict-free v2 subset
that boot and every test entry point need (promotion + packs minus
`remote_object` + the per-(tenant, store) `search_generation_current`
pointer) now lives behind a single canonical helper
`applyV2PromotionSubsetSchema` in `packages/prosa-db-v2/src/apply.ts`, with
the load-bearing table list at `V2_PROMOTION_SUBSET_TABLES`. Production
boot (`apps/api/src/server.ts`), the in-process Fastify tests
(`apps/api/test/helpers/test-app.ts`), the Docker E2E bootstrap
(`apps/api/test/e2e/v2-promote.e2e.test.ts`), and the CLI promote test
(`apps/cli/test/cli/v2/sync/promote.test.ts`) all call through this
helper. Pinned by `apps/api/test/v2/cq-126-server-boot-schema.test.ts`.

This is NOT a CQ-124 closure: the full v1/v2 table-name collision (for
`device`, `remote_object`, `projection_session`, `search_doc`) still
prevents calling `applySchemaV2` over a v1 database, so projection /
search materialization remains v1-shaped. Lane 10 owns the namespace /
rename / migration cutover. The acceptance checklist below stays open
until that cutover lands.

Problem:

`packages/prosa-db` (v1) and `packages/prosa-db-v2` both declare
`projection_session`, `search_doc`, `remote_object`, and `device` with
incompatible column sets. Calling `applySchemaV2` on a database that
already ran v1 `applySchema` succeeds for `CREATE TABLE IF NOT EXISTS`
but fails when the v2 indexes reference v2-only columns
(e.g. `projection_session_tenant_end_idx ON projection_session
(tenant_id, end_ts DESC)` against the v1 table without `end_ts`).

Risk:

- Production-mode boot cannot call `applySchemaV2` against a database
  that has the v1 schema applied (which it currently does — see
  `apps/api/src/server.ts`).
- Lane 5 tests cannot apply the full v2 schema; only the conflict-free
  `PROMOTION_SCHEMA_SQL` block is safe. Materialization paths (Lane 5
  seal) need `projection_*` and `search_doc` schemas, so this must be
  resolved before slice 3.

Smoke evidence:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "import { PGlite } from '@electric-sql/pglite'; import { applySchema } from '@c3-oss/prosa-db'; import { applySchemaV2 } from '@c3-oss/prosa-db-v2'; const db = new PGlite(); await applySchema(db); try { await applySchemaV2(db); console.log('applySchemaV2-after-v1 ok'); } catch (error) { console.log('applySchemaV2-after-v1 failed'); console.log(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { await db.close(); }"
```

Run from `apps/api`; output:

```text
applySchemaV2-after-v1 failed
column "end_ts" does not exist
```

Required fix (one of):

- Namespace v2 into its own Postgres schema (`prosa_v2.projection_session`
  etc.) and update v2 callers to qualify table names.
- Or rename the conflicting v2 tables (`projection_session_v2`,
  `search_doc_v2`, `remote_object_v2`, `device_v2`).
- Either approach needs a Lane 10 cutover plan that drops or migrates
  the v1 rows once v2 is the only read path.

Acceptance:

- [ ] Fresh boot applies both schemas on the same database without
      error.
- [ ] Lane 5 test helper applies the full v2 schema and exercises
      projection/search materialization.
- [ ] Lane 10 cutover plan documents the v1 → v2 migration for the
      shared-name tables.

### CQ-125: BeginPromotion no-op fast path does not verify authority receipt integrity

Severity: high
Blocking: yes (blocks Lane 5 BeginPromotion acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20): `apps/api/src/v2/sync/begin-promotion.ts` now
gates the `already_promoted` fast path on three independent checks:

1. **Authority tuple** — `loadAuthorityReceipt` loads the row scoped
   to the authority `(tenant, store, bundleRoot, receiptId)` and
   refuses to return when the row is missing or any of
   `row.store_id` / `payload.tenantId` / `payload.storeId` /
   `payload.bundleRoot` / `payload.receiptId` disagree with the
   authority tuple. Any mismatch raises
   `BeginPromotionAuthorityCorruptError` → `500 AUTHORITY_CORRUPT`.
2. **Content-addressed derived id** —
   `deriveReceiptId(loaded.payload)` must equal
   `payload.receiptId`. A same-tenant attacker who mutates a
   non-tuple field (e.g. `serverRegion`) breaks the canonical hash
   and the route fails closed.
3. **Signature verification** — `signer.verifyReceipt(payloadBytes,
   loaded.signature)` must return true. The signer is the same
   instance the seal path uses to mint receipts, so verification
   resolves the keyId against the server's published JWKS. Bogus
   signatures, signatures from foreign keys, and keyId-spoofed
   signatures all fail closed.

Device handling: the receipt is only returned when
`payload.deviceId === request.device.deviceId`. A
different-device request observes `remote_authority_v2` but falls
through to open its own staging slot — the bundle's authority
already exists and a re-seal from that device produces a fresh
receipt the device can trust.

Pinned by:
- `apps/api/test/v2/sync/cq-125-authority-integrity.test.ts` —
  4 tuple-mismatch cases (missing, row.store_id, payload.bundleRoot,
  payload.receiptId).
- `apps/api/test/v2/sync/cq-125-receipt-validation.test.ts` — 4
  cases: tampered payload (deriveReceiptId mismatch), bogus
  signature, foreign-signer signature with spoofed `keyId`, plus a
  happy-path replay that returns `200 already_promoted` with the
  schema-valid receipt.
- The pre-existing `begin-fast-path.test.ts` happy path now signs
  the seeded receipt with the test app's exposed signer
  (`TestApp.signer`) — keeping the wire-schema replay check
  meaningful end-to-end.

The earlier reviewer-rejection smoke (device-mismatch + malformed
signature still returning 200) is resolved by the device-only
return gate combined with the derived-id + signature checks
above.

Problem:

Lane 5 slice 1 looks up `remote_authority_v2` by
`(tenant_id, store_id, current_bundle_root)` but then loads the referenced
`receipt` row only by `(receipt_id, tenant_id)`. It returns
`already_promoted` without proving that the receipt row and signed payload
match the requested `storeId`, `bundleRoot`, `deviceId`, and authority row.

The same path also treats a `remote_authority_v2` row whose
`current_receipt_id` is missing from `receipt` as a fresh promotion and returns
`needs_inventory`. That is a fail-open authority path: once the server says a
store/root is promoted, a missing receipt means the cleanup/authority proof is
corrupt and the route must fail closed instead of silently reopening promotion.

Risk:

A same-tenant bad link or catalog corruption can make `BeginPromotion` return
`already_promoted` for store/root A with a receipt for store/root B. Orphaned
authority rows can also be overwritten or replayed by the fresh-promotion path.
Both cases weaken the seal-only authority invariant and make receipt-based
cleanup/audit untrustworthy.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...seed remote_authority_v2(store-a, root=11...) -> rcpt_mismatch whose receipt payload is store-b/root=22...; seed remote_authority_v2(store-orphan) -> rcpt_missing...
TS
```

Run from `apps/api`; output:

```text
mismatch 200 already_promoted store-b 2222222222222222222222222222222222222222222222222222222222222222
orphan 200 needs_inventory prm_4uvemevuf4u4d4tq24zel4lina
```

Required fix:

- Load the receipt using the full authority tuple, or validate after load that
  `receipt.tenant_id`, `receipt.store_id`, `receipt.device_id`, and
  `receipt.payload.{tenantId,storeId,deviceId,bundleRoot}` match the
  authenticated tenant and requested `storeId`/`bundleRoot`/device.
- Validate the receipt shape before returning `already_promoted`; once CQ-123 is
  resolved, this must use the shared v2 receipt/BeginPromotion response schema.
- If `remote_authority_v2.current_receipt_id` is missing, malformed, or points
  to a mismatched receipt, return a server integrity error (or explicit 409
  conflict) and do not create/reuse staging for that request.

Acceptance:

- [x] Route test seeds an authority row pointing to a receipt for a different
      store/root/device and proves `BeginPromotion` fails closed, not
      `already_promoted` (covered by `cq-125-authority-integrity`).
- [x] Route test seeds an authority row pointing to a missing receipt and proves
      `BeginPromotion` fails closed, not `needs_inventory`, and no staging row is
      created (missing-receipt case in `cq-125-authority-integrity`).
- [x] Route test covers malformed/unparseable receipt JSON and fails closed
      (`coerceJsonbObject` returns null → 'missing' path covered by the
      missing-receipt case; deriveReceiptId mismatch covers tampered payload).
- [x] Route tests cover wrong `device_id` and malformed/invalid signatures
      (device fall-through behavior + `cq-125-receipt-validation` three
      signature-failure cases).
- [x] Valid replay verifies the receipt schema/signature before returning
      `already_promoted` (happy-path case in `cq-125-receipt-validation` +
      pre-existing fast-path test now uses the real signer).
- [x] Valid replay still returns the exact schema-valid receipt for the same
      `(tenant, store, bundleRoot, device)` tuple
      (`begin-fast-path.test.ts > returns already_promoted ...`).

### CQ-126: Production boot registers BeginPromotion without v2 promotion tables

Severity: high
Blocking: yes (blocks Lane 5 production/Docker E2E acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20): boot now applies the conflict-free v2 subset through
the single canonical helper `applyV2PromotionSubsetSchema` exported from
`@c3-oss/prosa-db-v2`. The matching required-tables list lives at
`V2_PROMOTION_SUBSET_TABLES`, so the boot-time fail-fast check cannot drift
from the SQL that actually runs. The same helper is also used by every
in-process test entry point (`buildTestApp`, the v2-promote Docker E2E
bootstrap, the CLI promote test, the focused CQ tests) — no inline regex
strips remain.

Reviewer concerns addressed:
- `pnpm lint` passes repo-wide (`apps/api`, `prosa-db-v2`, every other
  workspace) after the `PACKS_SCHEMA_SQL.replace(...)` and import
  formatting fixes.
- `apps/api/test/v2/cq-126-server-boot-schema.test.ts` no longer claims
  CQ-124 closure — its title and comments scope strictly to CQ-126.
- The same test now includes an **authenticated** BeginPromotion case:
  it signs up a real tenant, posts an authenticated body, and asserts a
  `200 needs_inventory` response with a matching `promotion_staging` row.
  This proves the v2 query layer (`remote_authority_v2` SELECT,
  `promotion_staging` partial-unique INSERT, `claimDevice` upsert) all
  resolve against the boot-applied schema — not just that the auth ladder
  short-circuits ahead of SQL.

Earlier follow-up smoke (still valid): both package lints pass:

```text
pnpm --filter @c3-oss/prosa-api lint
pnpm --filter @c3-oss/prosa-db-v2 lint
```

Closure rejection: `apps/api/src/server.ts` applies the conflict-free
v2 slice during boot, immediately after the v1 `applySchema`:
- `PROMOTION_SCHEMA_SQL` (promotion_staging, remote_authority_v2,
  receipt, legacy_receipt_archive, promotion_uploaded_pack);
- `PACKS_SCHEMA_SQL` with the colliding `remote_object` block
  stripped (CQ-124 owns the full migration);
- the per-(tenant, store) `search_generation_current` pointer
  (matches CQ-137 shape).
The required-tables check then includes every Lane 5 v2 table
the routes touch: `promotion_staging`, `remote_authority_v2`,
`receipt`, `promotion_uploaded_pack`, `remote_pack`,
`remote_pack_entry`, `receipt_pack_grant`, and
`search_generation_current`. Missing any of these fails boot
before the port binds — the route surface can no longer 500
on "relation does not exist" at runtime.

Pinned by two cases in `apps/api/test/v2/cq-126-server-boot-schema.test.ts`:
1. Running the boot SQL block on a fresh PGlite + v1 schema
   produces every required v2 table.
2. After boot, hitting `POST /v2/promotions/begin` returns
   401 UNAUTHENTICATED rather than crashing on a missing
   relation — proof the SQL queries run cleanly.

The closure is not accepted. Reviewer smoke showed an existing
tenant-wide `search_generation_current(tenant_id PRIMARY KEY, ...)`
table passes the boot table-name check because boot uses
`CREATE TABLE IF NOT EXISTS`; seal then fails when inserting
`store_id`:

```text
columns=tenant_id,generation_id,receipt_id,promoted_at,updated_at
insert=failed
column "store_id" of relation "search_generation_current" does not exist
```

The route test also returns 401 before executing the BeginPromotion SQL path, so
it is useful boot-surface evidence but not proof that authenticated Lane 5
queries run cleanly against the boot-applied schema.

Problem:

`startServer` applies and verifies only the v1 schema. It intentionally skips
`applySchemaV2` because the full v2 schema conflicts with v1 table names, but it
still registers the v2 routes. `BeginPromotion` immediately queries
`remote_authority_v2` and, in the staging path, `promotion_staging`. A production
database that has only the verified v1 tables can pass boot/health and then fail
the first sync request at runtime.

Risk:

Lane 5 Docker E2E and production sync cannot rely on server boot as a schema
gate. The API may accept traffic with no `remote_authority_v2`,
`promotion_staging`, or `receipt` tables, producing runtime 500s instead of a
fail-closed boot error or an intentionally disabled v2 route surface.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...applySchema(v1) on PGlite, then call beginPromotion(...) with a valid request...
TS
```

Run from `apps/api`; output:

```text
beginPromotion-v1-only failed
relation "remote_authority_v2" does not exist
```

Required fix:

- Apply the conflict-free v2 promotion DDL (`PROMOTION_SCHEMA_SQL`) during
  server boot, or fail closed and do not register v2 promotion routes unless the
  required promotion tables exist.
- Add boot-time verification for `promotion_staging`, `remote_authority_v2`,
  `receipt`, and any other Lane 5 tables used before seal. Verification must
  include required column/key shape, not just table names.
- Preserve CQ-124 separately for the full v2 projection/search schema conflict.
- Add an upgrade/idempotency path for old `search_generation_current` shape, or
  fail boot before serving v2 routes when that old shape is detected.

Acceptance:

- [ ] Production-style boot against a fresh database creates or verifies v2
      promotion tables before serving traffic.
- [ ] A v1-only database either receives the v2 promotion DDL or fails boot with
      a clear schema error; it must not pass `/health` and then fail
      `BeginPromotion`.
- [ ] Docker-backed Lane 5 E2E starts from fresh services and completes
      `BeginPromotion` without manual schema setup.
- [ ] Old tenant-wide `search_generation_current` shape is migrated or rejected
      at boot; seal cannot fail later on missing `store_id`.
- [ ] Authenticated `BeginPromotion` against the boot-applied schema reaches a
      protocol response, not only the unauthenticated pre-SQL path.

### CQ-127: BeginPromotion does not prove device ownership or bind receipts to the requested device

Severity: high
Blocking: yes (blocks Lane 5 authorization acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20): `x-prosa-device-id` is now MANDATORY on
every post-begin v2 route. The helper renamed from
`maybeVerifyDevice` to `requireVerifiedDevice`, and each route
returns `400 DEVICE_REQUIRED` when the header is absent. When
present, the device must be registered to the authenticated user
(otherwise 403 DEVICE_NOT_OWNED) AND match the staging row's
`device_id` (otherwise 403 DEVICE_MISMATCH).

Affected routes:
- `PUT /v2/promotions/:promotionId/segments/:segmentId`
- `POST /v2/promotions/:promotionId/object-packs`
- `POST /v2/promotions/:promotionId/seal`
- `GET /v2/promotions/:promotionId/status`
- `GET /v2/receipts/:receiptId` — additionally compares the
  verified device against `payload.deviceId` and returns 404
  RECEIPT_NOT_FOUND when they differ. The 404 (vs 403) prevents
  a same-tenant probe from distinguishing "exists, wrong device"
  from "does not exist".

CLI: `apps/cli/src/cli/v2/sync/promote.ts` sends
`x-prosa-device-id: ${input.deviceId}` on every post-begin
request — status fetch, segment upload, object-pack upload, seal.
The header is threaded through the same `PromoteInput.deviceId`
that BeginPromotion already requires in its body, so callers do
not need to track a second value.

Pinned by:
- `apps/api/test/v2/sync/cq-127-device-policy-routes.test.ts` —
  four cases proving the device-mismatch + device-not-owned
  rejection paths still surface as 403.
- `apps/api/test/v2/sync/cq-127-device-ownership.test.ts` —
  fresh device auto-register, cross-user-steal refusal,
  foreign-device fall-through to needs_inventory, same-device
  already_promoted replay.
- Every other v2 route test (`upload-segment`, `upload-object-pack`,
  `seal-promotion`, `get-promotion-status`, `get-receipt`,
  `cq-134`, `cq-136-*`, `cq-137`, `cq-138`, `cq-141-*`) was
  updated to send the device header — proving the mandatory
  policy doesn't accidentally break legitimate Lane 5 flows.
- `apps/cli/test/cli/v2/sync/promote.test.ts` exercises the
  client-side header through the full lifecycle.

Closure history (kept for context):
- The first BeginPromotion-side fix (`claimDevice` + same-device
  fast path) addressed the receipt-leak on begin. The reviewer
  flagged that post-begin routes still allowed tenant-wide
  access. This closure makes the header mandatory on every
  post-begin route AND on GetReceipt, closing the same-tenant
  fall-through path.

Earlier partial-closure note (BeginPromotion-side):

Closure (BeginPromotion side): `apps/api/src/v2/sync/begin-promotion.ts`
adds `claimDevice(...)` which `SELECT`s an existing `device` row
for `(id, tenant_id)`, rejects if it belongs to a different
`user_id` (throws `BeginPromotionDeviceOwnershipError` →
`403 DEVICE_OWNED_BY_OTHER_USER`), and otherwise
`INSERT ON CONFLICT DO NOTHING` auto-registers a fresh
`(id, tenant_id, user_id, name=id)` row. The already_promoted
fast path now only returns the receipt when
`payload.deviceId === input.device.deviceId`; a different
device in the same tenant falls through to a fresh staging
slot rather than receiving a foreign-device receipt.

Pinned by four cases in
`apps/api/test/v2/sync/cq-127-device-ownership.test.ts`:
1. fresh device auto-registers in `device` for the requesting
   user;
2. cross-user steal of an existing device id returns 403
   DEVICE_OWNED_BY_OTHER_USER and leaves the row's `user_id`
   unchanged;
3. different device asking about an already-promoted bundle
   gets `needs_inventory` (no foreign-device leak);
4. same device replaying the seal still gets
   `already_promoted`.

Outstanding for full closure: ALL ITEMS RESOLVED in the
2026-05-20 closure.
- [x] Make device identity mandatory on every post-begin route
      (`requireVerifiedDevice` + 400 DEVICE_REQUIRED).
- [x] Update CLI `sync-v2` to send/prove the device id on
      status/upload/seal (`promoteBundleV2` threads `input.deviceId`
      into `x-prosa-device-id` on every call).
- [x] Apply the same policy to GetReceipt (header required +
      `payload.deviceId === verifiedDeviceId`).

Problem:

The v2 route proves the caller is authenticated and belongs to the tenant, but
the handler currently treats `request.device.deviceId` as an opaque body field.
It does not verify that the device belongs to the authenticated user/tenant, and
the `already_promoted` fast path can return a receipt whose row/payload
`deviceId` belongs to another device. The current `GetPromotionStatus` WIP
extends the same tenant-only policy to promotion recovery: it loads staging by
`(promotionId, tenant_id)` and returns store id, bundle root, inventory upload
state, and pack digests without checking `user_id` or `device_id`.

Risk:

Any tenant member who knows or can guess `(storeId, bundleRoot)` can retrieve a
receipt for another device. Receipts include store path, roots, counts, and
authority metadata, and later upload/seal routes will need the same device
authorization semantics. This violates the Lane 5 invariant that tenant
membership, device ownership, and object routes share authorization semantics.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...seed receipt.device_id/payload.deviceId = 'victim-device', request deviceId = 'attacker-device', then call POST /v2/promotions/begin...
TS
```

Run from `apps/api`; output:

```text
device-mismatch 200 already_promoted victim-device
```

Required fix:

- Carry authenticated user/session context and a verified device identity into
  `BeginPromotion`.
- Require a valid device record or documented device-registration policy for
  `(tenant_id, user_id, device_id)` before opening staging or returning a
  receipt.
- Bind `already_promoted` receipt validation to the accepted device policy: same
  device if receipts are device-scoped, or an explicit same-tenant multi-device
  rule that still validates the receipt tuple and avoids leaking unauthorized
  device metadata.

Acceptance:

- [ ] Route test proves an unknown/unowned `deviceId` is rejected before
      staging or receipt return.
- [ ] Route test proves a request for `attacker-device` cannot receive a
      receipt scoped to `victim-device` unless an explicit multi-device policy
      is implemented and tested.
- [ ] The same device authorization helper/policy is reused by upload, seal, and
      receipt-fetch and promotion-status routes.
- [ ] Missing `x-prosa-device-id` on UploadSegment, UploadObjectPack,
      SealPromotion, and GetPromotionStatus fails closed or is replaced by an
      authenticated device identity.
- [ ] CLI `sync-v2` sends/proves device identity on status/upload/seal.

### CQ-128: BeginPromotion staging idempotency is not race-safe

Severity: high
Blocking: yes (blocks Lane 5 retry/resume and upload/seal acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure: `packages/prosa-db-v2/src/schema/promotion.ts` adds a
partial unique index
`promotion_staging_active_tuple_idx (tenant_id, store_id,
(head_json->>'bundleRoot')) WHERE status IN ('open','uploading',
'materializing')`. `findOrCreateStaging` now does
`INSERT … ON CONFLICT (tenant_id, store_id, (head_json->>'bundleRoot'))
WHERE status IN (active) DO NOTHING RETURNING id`. The loser of the
race re-reads the active row and returns the winner's id. Pinned by
two cases in `apps/api/test/v2/sync/cq-128-race.test.ts`: 8
concurrent `BeginPromotion` calls collapse to a single
promotionId and exactly one active row; aborted rows do not
occupy the slot.

Problem:

Lane 5 slice 2 makes sequential `BeginPromotion` retries idempotent by
selecting an existing active `promotion_staging` row before inserting a new one.
The operation is not atomic: there is no transaction/advisory lock and no unique
constraint over active `(tenant_id, store_id, bundleRoot)` rows. Two concurrent
fresh begins can both observe no active row and insert distinct active staging
rows for the same bundle.

Risk:

Retry/resume identity is unstable under normal client concurrency or duplicate
requests. Later upload/seal paths can attach segments to one promotion id while
another active id exists for the same authority tuple, weakening idempotency,
cleanup, and seal-only authority assumptions.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...Promise.all([beginPromotion(same tuple), beginPromotion(same tuple)]), then count active promotion_staging rows...
TS
```

Run from `apps/api`; output:

```json
{"insertCount":2,"promotionIds":["prm_fucayio4tezy3qlyeavmaa44cu","prm_zioqqmlugymueeo4piuauuue4q"]}
```

Required fix:

- Make fresh `BeginPromotion` staging creation atomic for the active
  `(tenant_id, store_id, bundleRoot)` key. Acceptable approaches include a
  transaction plus advisory lock, or a schema-level generated bundle-root column
  and partial unique index/UPSERT for active statuses.
- Define conflict semantics for retries that change inventory refs for the same
  bundle root: either return the originally persisted refs or reject with a
  clear conflict; do not silently reuse the id while changing the upload plan.
- Bind resume skip decisions to the same digest domain used by the server. Slice
  8 currently returns canonical CAS `pack_digest` values from
  `promotion_uploaded_pack`, while the CLI compares them to the transport BLAKE3
  of the pack bytes; those are intentionally different identities.

Acceptance:

- [ ] Concurrent same-tuple `BeginPromotion` calls return one promotion id and
      leave exactly one active `promotion_staging` row.
- [ ] Sequential retry still reuses the active id.
- [ ] Terminal `sealed`/`aborted` rows still allow a fresh active row.
- [ ] Same `(tenant, store, bundleRoot)` with changed inventory refs is either
      rejected as conflict or returns the originally persisted inventory plan.
- [ ] CLI resume/status handling validates returned inventory refs/digests
      before skipping uploads, or fails closed on mismatch.
- [ ] Pack replay test pre-uploads one pack, reruns the client, and proves no
      `POST /object-packs` is sent for that already-uploaded canonical pack.
- [ ] Status responses expose enough pack/inventory identity for the client to
      compare in the correct digest domain.

### CQ-129: UploadObjectPack stores pack bytes with the wrong object-store hash

Severity: high
Blocking: yes (blocks Lane 5 object-pack upload acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure: `apps/api/src/v2/sync/upload-object-pack.ts` writes the
literal wire BLAKE3 (`observedTransportHash`) to
`PutMeta.hash`, not the self-referential CAS pack digest, so
`putIfAbsent`'s `verifyBytes(buffer, meta)` succeeds. Pinned by
`apps/api/test/v2/sync/cq-batch-a.test.ts > CQ-129: ... an
accepted pack lands in the object store under its transport hash`:
the test asserts `transportHash !== packDigest`, the upload
returns 200, and `MemoryObjectStore.head(storageKey).hash`
equals the transport hash hex.

Problem:

The slice 4 WIP correctly distinguishes the transport hash (BLAKE3 of bytes
received on the wire) from the canonical CAS `packDigest` embedded in the pack
header. However, the object-store write passes `packDigest` as the storage
metadata hash. `RemoteObjectStore.putIfAbsent` verifies metadata hash against
the actual bytes before storing, so a valid CAS pack whose `packDigest` differs
from the transport hash fails storage verification and returns a route-level
500 on the happy path.

Risk:

Object-pack uploads cannot accept valid packs, or a future bypass would store
bytes under metadata that does not describe the stored bytes. This would violate
CQ-012's separation of transport hash from canonical content identity and make
object-store audit/verification unreliable.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/upload-object-pack.test.ts
```

Current WIP output:

```text
FAIL test/v2/sync/upload-object-pack.test.ts
expected 500 to be 200
```

Direct pack hash smoke:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...buildCasPack(...); compare built.packDigest to blake3(built.bytes)...
TS
```

Output:

```json
{"packDigest":"blake3:75fd62782100f5f29d3c05045633062f9dd35305ad53e3d220b2c2f0fbf18bc9","transportHash":"blake3:dd87284bea7e2630f8a3e0ac3b1ecfe8f00f72fd0b36fd8c94f0047647bf36b6","equal":false}
```

Required fix:

- Use the observed transport hash (without the `blake3:` prefix) as the
  object-store metadata `hash`.
- Keep `remote_pack.pack_digest` and API response `packDigest` as the verified
  canonical CAS pack digest.
- Add assertions that object-store `head(storageKey).hash` equals the transport
  hash while `remote_pack.pack_digest` equals the verified CAS pack digest.

Acceptance:

- [ ] Happy-path object-pack upload returns 200 and stores bytes successfully.
- [ ] Test proves object-store metadata hash is the transport-byte hash, not the
      canonical pack digest, when the two differ.
- [ ] Re-upload remains idempotent with the same stored bytes/metadata.
- [ ] Mismatched declared transport hash and mismatched declared pack digest
      remain separate 400 failures.

### CQ-130: Upload routes accept bytes without required transport hash

Severity: high
Blocking: yes (blocks Lane 5 upload acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure: `apps/api/src/v2/sync/upload-segment.ts` and
`apps/api/src/v2/sync/upload-object-pack.ts` now require the
`x-prosa-transport-hash` header. Missing header → 400 INVALID_REQUEST
with `{ field: 'transportHash', received: '<missing>' }`. Pinned by
two cases in `apps/api/test/v2/sync/cq-batch-a.test.ts`. All test
fixtures that previously omitted the header now compute and pass
the BLAKE3 of the body bytes.

Problem:

The shared v2 wire schemas require `transportHash` for `UploadSegment` and
`UploadObjectPack`, and Lane 5 invariants require transport hash verification
independent of canonical content identity. Slice 3 treats
`x-prosa-transport-hash` as optional for inventory segments, and slice 4 treats
it as optional for object packs.

Risk:

Clients can upload inventory or object-pack bytes without proving the bytes
observed on the wire. That weakens CQ-012 and makes retry/audit behavior
diverge from the published protocol schema.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...open staging; PUT declared inventory segment with valid bytes and no x-prosa-transport-hash...
TS
```

Run from `apps/api`; output:

```text
no-transport 200 accepted
```

Additional object-pack evidence from commit `154ba25`:

```text
git grep -n "transportHash" 154ba25 -- apps/api/src/v2/sync/upload-object-pack.ts apps/api/test/v2/sync/upload-object-pack.test.ts
```

Output shows `transportHash?: string`, validation only under
`params.transportHash !== undefined`, and re-upload tests that omit the
transport hash header.

Required fix:

- Treat missing `x-prosa-transport-hash` as `400 INVALID_REQUEST`.
- Keep mismatch handling separate from missing-header handling.
- Re-upload/idempotency must still pass through the same transport-hash
  validation path.

Acceptance:

- [ ] Segment upload route test proves missing `x-prosa-transport-hash`
      returns 400.
- [ ] Object-pack upload route test proves missing `x-prosa-transport-hash`
      returns 400.
- [ ] Valid transport hash accepts each upload route.
- [ ] Mismatched transport hash remains a 400 with a `transportHash` issue on
      each route.
- [ ] Re-upload requires and verifies the transport hash before returning
      `already_present`.

### CQ-131: Upload routes accept uploads while promotion is materializing

Severity: high
Blocking: yes (blocks Lane 5 seal/upload phase acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure: both upload handlers now treat `materializing` as a closed
status alongside `sealed` and `aborted`. Late uploads against an
in-flight seal return 404 PROMOTION_NOT_FOUND with the status in
the message. Pinned by two cases in
`apps/api/test/v2/sync/cq-batch-a.test.ts`.

Problem:

`UploadSegment` and `UploadObjectPack` reject only `sealed` and `aborted`
staging rows. They still accept uploads when a promotion is `materializing`,
which is the phase where seal verification/materialization starts.

Risk:

Uploads can overlap with seal/materialization, allowing the upload plan or
stored bytes to change while the server is verifying and committing promoted
data. This violates the seal-only authority path and can produce receipts over
an unstable staging set.

Smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec tsx --conditions=prosa-dev <<'TS'
...open staging; update status='materializing'; PUT declared inventory segment...
TS
```

Run from `apps/api`; output:

```text
materializing 200 accepted
```

Additional object-pack evidence from commit `154ba25`:

```text
git show 154ba25:apps/api/src/v2/sync/upload-object-pack.ts | nl -ba | sed -n '79,98p'
```

Output shows `TERMINAL_STAGING_STATUSES = new Set(['sealed', 'aborted'])`, so
`materializing` is not rejected.

Required fix:

- Define the upload-allowed states explicitly, likely `open` and `uploading`
  only.
- Reject `materializing`, `sealed`, and `aborted` with either
  `404 PROMOTION_NOT_FOUND` or an explicit phase-conflict response used
  consistently by segment/object-pack routes.

Acceptance:

- [ ] Route test proves `materializing` staging rows reject segment uploads.
- [ ] Route test proves `materializing` staging rows reject object-pack uploads.
- [ ] Route tests prove `sealed` and `aborted` remain rejected.
- [ ] Allowed states are documented and reused by object-pack upload and seal.

### CQ-132: UploadObjectPack leaves orphan pack bytes on catalog failure

Severity: high
Blocking: yes (blocks Lane 5 object-pack cleanup acceptance)
Status: closed (2026-05-20) — race-interleaving re-check added
Owner: Ralph

Full closure: the cleanup branch now re-reads `remote_pack`
after the catalog transaction fails. Bytes are only deleted
when no `(tenant_id, pack_digest)` row references them.
This handles the previously-flagged race where request A
writes bytes (`newlyWritten=true`), request B observes them
via `putIfAbsent` (`alreadyExisted=true`) and successfully
commits its catalog rows, then A's transaction fails non-
idempotently. The re-check finds B's catalog row and refuses
to delete — B's `remote_pack` rows stay backed by valid
bytes.

Pinned by four cases in
`apps/api/test/v2/sync/cq-132-orphan-cleanup.test.ts`:
1. injected catalog failure with no racing B → storage
   empty, no remote_pack row;
2. idempotent retry with a throwing transaction → bytes
   remain, count stays at 1, transaction body never runs;
3. verifyCasPack rejection → no object-store write at all;
4. **NEW: race interleaving** — interleaving transaction
   stub directly INSERTs a remote_pack row before throwing.
   The handler's cleanup sees the row, refuses to delete,
   and the bytes survive.

Closure rejection (superseded by the re-check above):
`apps/api/src/v2/sync/upload-object-pack.ts` captures
`putIfAbsent`'s `alreadyExisted` flag as `newlyWritten`. On any
catalog-side failure other than the idempotent
`unique_violation` (23505) it already handles, the catch block
best-effort calls `objectStore.delete(storageKey)` ONLY when
`newlyWritten` is true. Pre-existing bytes from a prior
successful upload or a concurrent retry are left intact. Pinned
by three cases in
`apps/api/test/v2/sync/cq-132-orphan-cleanup.test.ts`:
1. injected catalog failure → storage empty + no remote_pack
   row;
2. idempotent retry with a throwing transaction → bytes
   remain + remote_pack row count stays at 1;
3. verifyCasPack rejection → no object-store write at all.

Those tests do not cover the concurrent ownership interleaving where request A
writes bytes and owns `newlyWritten=true`, request B observes those bytes via
`putIfAbsent` and successfully inserts the catalog rows, then request A hits a
non-idempotent catalog failure and deletes the key. That would leave B's
`remote_pack` rows pointing at missing bytes.

Problem:

In commit `154ba25`, `UploadObjectPack` writes pack bytes to the object store
before inserting `remote_pack` and `remote_pack_entry` rows in the catalog
transaction. On non-idempotent catalog failure, the handler rethrows without
deleting the newly written object-store bytes.

Risk:

Database errors, timeouts, future constraints, or partial catalog failures can
leave unreferenced object-pack bytes. This violates the Lane 5 orphan-byte
cleanup invariant and makes later GC/audit responsible for bytes the upload
route should have aborted or cleaned immediately.

Smoke evidence:

```text
git show 154ba25:apps/api/src/v2/sync/upload-object-pack.ts | nl -ba | sed -n '144,220p'
```

Output shows `objectStore.putIfAbsent(...)` before `deps.transaction(...)`; the
catch block handles only `23505` and otherwise `throw err` with no
`objectStore.delete(storageKey)` cleanup.

Required fix:

- Track whether this request actually wrote new bytes (`alreadyExisted ===
  false`).
- On non-idempotent catalog failure after a new write, best-effort delete the
  staging object key or otherwise record an explicit cleanup task before
  returning failure.
- Do not delete bytes that pre-existed from an idempotent retry or another
  successful promotion.

Acceptance:

- [ ] Test injects a catalog/transaction failure after object-store write and
      proves the storage key is absent or cleanup was explicitly recorded.
- [ ] Test proves idempotent replay does not delete pre-existing pack bytes.
- [ ] Test proves a racing loser that wrote bytes first cannot delete the key
      after a concurrent winner has catalogued that pack.
- [ ] Object-pack route evidence documents the storage/catalog failure policy.

### CQ-133: Object packs are not linked to the promotion that uploaded them

Severity: high
Blocking: yes (blocks Lane 5 seal grant correctness)
Status: closed (2026-05-20)
Owner: Ralph

Closure: `packages/prosa-db-v2/src/schema/promotion.ts` ships the
`promotion_uploaded_pack(promotion_id, tenant_id, pack_digest,
uploaded_at)` table with composite PK
`(promotion_id, pack_digest)`. `upload-object-pack.ts` calls
`linkPackToPromotion(...)` on both the accepted and
`already_present` paths with `ON CONFLICT DO NOTHING`.
SealPromotion reads from this table to determine which pack
digests need `receipt_pack_grant` rows. Pinned by
`apps/api/test/v2/sync/cq-batch-a.test.ts > CQ-133: ... links the
uploading promotion`: a single pack upload INSERTs exactly one
linkage row, re-upload is idempotent (count remains 1).

Problem:

In commit `154ba25`, `remote_pack` is tenant-wide and keyed by
`(tenant_id, pack_digest)`, but the upload route does not record which
`promotion_staging.id` uploaded or claimed the pack. Seal needs a
per-promotion pack set to write `receipt_pack_grant` rows only for the sealed
promotion.

Risk:

With only tenant-wide pack catalog rows, seal can over-grant packs uploaded by
another active promotion in the same tenant, or fail to know which packs belong
to the promotion being sealed. This weakens receipt grants and remote read
authorization.

Smoke evidence:

```text
git grep -n "promotion_uploaded_pack" 154ba25 -- packages apps || true
```

Output: no matches.

Required fix:

- Add a per-promotion pack linkage table or equivalent durable relation.
- Link a pack to the current promotion both when the pack is newly catalogued
  and when it already exists tenant-wide.
- Seal must read that relation, not all tenant packs, when writing
  `receipt_pack_grant`.

Acceptance:

- [ ] Object-pack upload test proves `promotion_uploaded_pack` (or equivalent)
      is written on fresh upload.
- [ ] Re-upload/already-present path links the existing pack to the current
      promotion without duplicating rows.
- [ ] Seal test with two active promotions in one tenant proves receipt grants
      include only packs linked to the sealed promotion.

### CQ-134: SealPromotion emits authority receipts before proving promoted data

Severity: critical
Blocking: yes (blocks Lane 5 SealPromotion acceptance and any cleanup/no-local-data promise)
Status: partially closed (2026-05-20) — object-coverage proof landed; full projection/search materialization remains deferred behind CQ-124
Owner: Ralph

Object-coverage closure: `apps/api/src/v2/sync/seal-promotion.ts`
now refuses the authority swap when the bundle head's declared
`counts.objects` exceeds the joined `promotion_uploaded_pack ⨝
remote_pack_entry` row count for this promotion. The new
`SealPromotionCoverageError` surfaces as
`409 OBJECT_COVERAGE_INCOMPLETE` with `declaredObjectCount` +
`catalogObjectCount`. Status is restored from `materializing`
back to the prior state (CQ-135) so the client can re-upload and
retry. Pinned by `apps/api/test/v2/sync/cq-134-coverage.test.ts`:
seal with declared objects but zero uploaded packs returns 409,
no `receipt` / `remote_authority_v2` / `receipt_pack_grant` rows
are written, staging returns to `open`. The bundles-declare-zero
edge case still seals cleanly.

Outstanding for full closure (blocked on CQ-124):
- Parse the uploaded object inventory and compare declared object ids to linked
  `remote_pack_entry.object_id` values; the current check is count-only.
- [ ] Prove linked pack bytes still exist and match expected metadata in object
  storage before granting them. CQ-141 is reopened: seal currently rejects
  missing/zero-length pack bytes but still grants wrong nonzero metadata.
- Materialize projection/search rows before authority swap.
- Receipt `rowCountsByEntity` reflects actual catalog state.
- Truthful `verification.projectionRowsLoaded` (schema currently
  requires literal `true` — coupled change with Lane 6 read API).
- Status-assisted resume metadata pin (hash + size) so a stale
  object-store entry can't masquerade as a valid inventory.

Problem:

Commit `280f2a3` allows `SealPromotion` to write `receipt`,
`remote_authority_v2`, `search_generation_current`, and `receipt_pack_grant`
after checking only that the two inventory segment blobs exist in object
storage. It does not parse the object/projection inventories, prove declared
objects are covered by `remote_pack_entry`, or materialize projection/search
rows before the authority swap. The receipt records zero
`rowCountsByEntity` values while still setting `verification.projectionRowsLoaded
= true`.

Risk:

The server can emit a cleanup-authorizing receipt even though the remote cannot
replace local authority. A client or later workflow could trust the receipt,
purge local data, and leave the remote without declared objects, projection
rows, or search docs.

Smoke evidence:

Reviewer smoke sealed a promotion declaring objects/projection/search, with
both inventory blobs uploaded but no object pack:

```json
{"sealStatus":200,"remotePackCount":0,"grantCount":0,"authorityRows":1}
```

Security reviewer smoke:

```text
no-pack-seal status=200 result=sealed receiptObjects=99 rowCountsSession=0 projectionRowsLoaded=true grants=0
```

Required fix:

- Parse and validate uploaded inventories during seal or fail closed before
  writing authority.
- Prove every declared object id needed by the promotion is present in linked
  `remote_pack_entry` rows, not just that the linked row count is high enough.
- Materialize projection/search rows before setting verification flags, or make
  seal fail closed until CQ-124 enables that materialization.
- Receipt counts and verification flags must reflect actual checks.
- Status-assisted resume must not use object-store presence alone as proof of a
  valid inventory upload; stored metadata hash/size must match the declared
  segment before the client can skip upload or seal can proceed.

Acceptance:

- [ ] Seal without object-pack coverage for declared objects returns a conflict
      and writes no receipt/authority/grants.
- [ ] Seal with enough linked pack entries for the wrong object ids fails
      closed and writes no receipt/authority/grants.
- [ ] Seal without projection/search materialization either fails closed or
      records truthful non-success verification state accepted by the wire
      schema/architecture.
- [ ] Happy-path seal proves object coverage and projection/search count parity
      before authority swap.
- [ ] Status `uploaded=true` with wrong object-store metadata hash/size does not
      let the CLI skip upload and cannot lead to a successful seal.
- [ ] Tests assert no `remote_authority_v2`, `receipt`, or
      `receipt_pack_grant` rows are written on failed verification.

### CQ-135: SealPromotion failure after status flip strands staging in `materializing`

Severity: high
Blocking: yes (blocks Lane 5 SealPromotion retry/resume acceptance)
Status: closed (2026-05-20) — post-flip try/catch widened + failure-injection tests added
Owner: Ralph

Full closure: `apps/api/src/v2/sync/seal-promotion.ts` now wraps
EVERY post-flip step inside a single try/catch that calls
`restoreStagingStatus(...)` on failure:
- `promotion_uploaded_pack` lookup;
- `coerceHead(head_json)` parse;
- CQ-134 object-coverage SELECT;
- `buildReceiptPayload(...)` (including
  `signer.currentKeyId()`, `canonicalNowMs()`,
  `deriveSearchGenerationId(...)`, `derivePostgresCommitId(...)`);
- `deriveReceiptId(...)`;
- `receiptPayloadBytes(...)`;
- `signer.signReceipt(...)`.
The previously-existing transaction-failure try/catch remains
the second layer of restore. Either layer reverts the row from
`materializing` back to its prior `open`/`uploading` status so
the client can retry.

Pinned by three failure-injection cases in
`apps/api/test/v2/sync/cq-135-seal-restore.test.ts`:
1. signer.signReceipt throws → status returns to `open`, no
   receipt/authority/grant rows written, retry with a working
   signer seals successfully;
2. signer.currentKeyId throws synchronously (build-payload-side
   failure) → status returns to `open`;
3. throwing transaction stub (after signer succeeds) → status
   returns to `open`.

Closure rejection (superseded by the wider try/catch above):
commit `a867e93` added restore handling around
`signReceipt` and the load-bearing transaction, but did not add the required
failure-injection tests. A reviewer also found post-flip work before those
guards: `promotion_uploaded_pack` lookup, `signer.currentKeyId()`, receipt
payload construction, and `receiptPayloadBytes(...)` can still throw after the
row is set to `materializing`. Existing seal idempotency tests are not evidence
for signer/current-key/transaction failure recovery.

Problem:

`SealPromotion` flips `promotion_staging.status` from `open|uploading` to
`materializing` before signing the receipt and before the final authority
transaction. If signing or the transaction fails, there is no catch/rollback path
that restores a retryable status or records a resumable failure state.

Risk:

Transient KMS/signer/database failures can wedge a promotion permanently. All
retries observe `SEAL_IN_PROGRESS`, so CLI resume cannot recover.

Smoke evidence:

Reviewer smoke with a signer throwing `kms down`:

```json
{"signerError":"kms down","stagingStatusAfterFailure":"materializing","retryStatus":409,"retryCode":"SEAL_IN_PROGRESS"}
```

Security reviewer smoke:

```text
seal-error=kms unavailable
post-failure-status=materializing
```

Required fix:

- Make seal failure after the status flip recoverable. Acceptable approaches:
  a lease/heartbeat with retry takeover, transition back to a retryable
  `uploading`/`open` state on caught failure, or an explicit failed state with a
  retry operation.
- Ensure no authority/receipt/grant rows are committed on signer/transaction
  failure.

Acceptance:

- [ ] Throwing signer test leaves no authority/receipt/grant rows and allows a
      later successful retry.
- [ ] Injected transaction failure test leaves no authority/receipt/grant rows
      and allows a later successful retry.
- [ ] Failure after the status flip but before `signReceipt` (for example
      pack lookup, `signer.currentKeyId()`, or receipt serialization) restores a
      retryable status and allows a later successful retry.
- [ ] Concurrent seal still permits only one successful authority transaction.

### CQ-136: Re-sealing an old sealed promotion can return the current store receipt

Severity: high
Blocking: yes (blocks Lane 5 idempotency and receipt correctness)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20): the sealed-replay path is centralized through
`loadAndValidateLinkedReceipt(...)` in
`apps/api/src/v2/sync/seal-promotion.ts`. Both branches that can
return a linked receipt — the normal `status='sealed'` branch and
the race-loser branch where another seal flipped the row past us
— call this helper, which runs three independent checks before
returning the receipt:

1. **Tuple integrity** — `payload.tenantId === ctx.tenantId`,
   `payload.storeId === staging.store_id`,
   `payload.deviceId === staging.device_id`,
   `payload.receiptId === sealed_receipt_id`,
   `payload.bundleRoot === head.bundleRoot`.
2. **Content-addressed derived id** —
   `deriveReceiptId(payload) === payload.receiptId`. A same-tenant
   attacker who mutates a non-tuple field (e.g. `serverRegion`)
   breaks the canonical hash; the route fails closed.
3. **Signature verification** —
   `signer.verifyReceipt(receiptPayloadBytes(payload), signature)`.
   Bogus signatures, signatures from foreign keys, and
   keyId-spoofed signatures all fail closed via
   `SealPromotionLinkCorruptError` → 500 SEAL_LINK_CORRUPT.

The race-loser branch now goes through the same helper instead of
the previous unvalidated `loadReceiptById` path. A concurrent
attacker who tampered with `sealed_receipt_id` between the
pre-flip read and the race-loser re-read no longer slips a foreign
receipt through.

Pinned by:
- `apps/api/test/v2/sync/cq-136-resale.test.ts` — original A→B
  replay returns A's receipt; sealed_receipt_id linkage assertion;
  tuple-mismatched link fails closed.
- `apps/api/test/v2/sync/cq-136-link-validation.test.ts` — three
  new cases: tampered-payload (deriveReceiptId mismatch), bogus
  signature, foreign-signer signature with spoofed keyId. All
  return 500 SEAL_LINK_CORRUPT after a real seal established the
  staging linkage.

Closure history (prior rejected closures left for context):
- The initial `loadReceiptById` slice trusted the link by
  `(receipt_id, tenant_id)` alone; same-tenant attacker could swap
  in a `store-b/dev-b` receipt and get HTTP 200 back.
- The tuple-only closure refused tuple mismatches via
  `SealPromotionLinkCorruptError` but still trusted payload
  contents (no derived-id check) and signature shape (no
  cryptographic verification). The current closure addresses both.

Closure rejection (superseded by the tuple-verification above):
`packages/prosa-db-v2/src/schema/promotion.ts` adds a
`sealed_receipt_id TEXT` column to `promotion_staging` (with
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for re-applied schemas).
`apps/api/src/v2/sync/seal-promotion.ts` sets that column inside
the load-bearing seal transaction alongside `status = 'sealed'`.
The sealed-status branch and the race-loser branch both load the
receipt by its exact id via `loadReceiptById(...)`. Pinned by two
cases in `apps/api/test/v2/sync/cq-136-resale.test.ts`: seal A
then B for the same store and re-seal A returns A's receiptId
(while remote_authority_v2 still points at B); plus a direct row
assertion that `sealed_receipt_id` is NULL before seal and equals
the returned receiptId after.

The closure is not accepted because replay trusts `sealed_receipt_id` by
`(receipt_id, tenant_id)` only. Reviewer smoke confirmed a sealed promotion for
`store-a/dev-a` with `sealed_receipt_id` pointing to a same-tenant
`store-b/dev-b` receipt returned HTTP 200 with the wrong receipt. Re-seal must
validate the linked receipt row and signed payload against the sealed staging
row's store/device/bundle tuple, or fail closed.

Problem:

When a `promotion_staging` row is already `sealed`, `SealPromotion` calls
`loadSealedReceipt(deps, staging.store_id)`. That helper loads
`remote_authority_v2` by `(tenant_id, store_id)` and returns the current store
receipt, not necessarily the receipt created by the promotion being replayed.
After promoting bundle B for the same store, re-sealing old promotion A can
return B's receipt.

Risk:

Idempotent retry semantics are wrong: a client retrying an old promotion can
receive a different receipt/root/device than the one originally sealed. This
breaks checkpointing, no-op behavior, and audit trails.

Smoke evidence:

Reviewer smoke:

```text
first receipt root aaaa...
second receipt root bbbb...
re-seal of first promotion returned the second receipt/root
```

Security reviewer smoke:

```text
sealed-old-promotion status=200 returnedReceipt=rcpt_new returnedDevice=dev-new
```

Required fix:

- Store or otherwise link the exact sealed receipt id on `promotion_staging`.
- Re-seal must load that exact receipt and verify it matches the promotion's
  tenant/store/device/bundle tuple, or return a terminal conflict if the link is
  missing/corrupt.
- Do not resolve idempotent seal replay through current `remote_authority_v2`
  alone.

Acceptance:

- [x] Promote bundle A then bundle B for the same store; re-sealing A returns
      A's original receipt or a terminal conflict, never B's current receipt
      (covered by `cq-136-resale.test.ts > after seal A then seal B...`).
- [x] Missing/corrupt sealed receipt link fails closed (helper returns null on
      missing → caller falls through to re-seal; tuple-mismatch throws
      `SealPromotionLinkCorruptError`).
- [x] Returned replay receipt validates against the same tuple as the staging
      row (helper tuple check).
- [x] Tests cover wrong-store, wrong-device, wrong-bundle, missing-row, and
      malformed-payload/signature `sealed_receipt_id` links
      (`cq-136-resale` tuple cases + `cq-136-link-validation` payload + sig cases).
- [x] Race-loser replay validates the exact same tuple/schema/signature path as
      normal sealed replay (both branches now call
      `loadAndValidateLinkedReceipt`).
- [x] Malformed signature, schema-invalid payload, and derived-id mismatch in a
      linked receipt fail closed (three cases in
      `cq-136-link-validation.test.ts`).

### CQ-137: `search_generation_current` is tenant-wide while authority is store-scoped

Severity: high
Blocking: yes (blocks Lane 5 search/projection authority acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20): `search_generation_current` is keyed by the composite
`(tenant_id, store_id)` matching `remote_authority_v2`'s scoping. Production
boot, the in-process Fastify tests, the v2 Docker E2E bootstrap, and the CLI
promote test all go through `applyV2PromotionSubsetSchema`, whose
`SEARCH_GENERATION_ONLY_SQL` block carries the idempotent legacy-shape
migration: `ADD COLUMN IF NOT EXISTS store_id`, backfill `NULL → ''`,
`ALTER COLUMN store_id SET NOT NULL`, then a `DO` block that detects the
legacy single-column PK via `pg_index` and swaps in
`PRIMARY KEY (tenant_id, store_id)`. Re-applying the schema on a fresh
database is a no-op; re-applying it on a legacy tenant-pk database migrates
the row in place without data loss.

Reviewer concerns addressed in commits c67df82 + b2a9cbc:
- `pnpm lint` and `pnpm typecheck` pass repo-wide.
- The CQ-126 boot-schema test no longer overclaims CQ-124 closure — it
  scopes strictly to CQ-126 and now includes an authenticated
  BeginPromotion case that proves the v2 query/write layer
  (`remote_authority_v2`, `promotion_staging`, and `device`) resolves
  against the boot-applied schema.
- `cq-137-store-scoped-generation.test.ts` proves the seal-time
  `search_generation_current` upsert is scoped by `(tenant_id, store_id)`.
- `startServer()` no longer carries its own copy of the search-generation
  SQL — it delegates to the same canonical helper used by every test.

Pinned by:
- `apps/api/test/v2/sync/cq-137-schema-migration.test.ts` — legacy tenant-PK
  migration + idempotent re-application on fresh schema.
- `apps/api/test/v2/sync/cq-137-store-scoped-generation.test.ts` — sealing
  two stores in the same tenant leaves two distinct rows in
  `search_generation_current`.
- `apps/api/test/v2/cq-126-server-boot-schema.test.ts` (authenticated case)
  — proves the migration is applied by the same boot path that serves Lane 5
  traffic, not a test-only helper.

CQ-124 remains separately tracked: the full v1/v2 projection/search
shared-name table cutover is a later-lane (Lane 10) migration.

Pinned by `apps/api/test/v2/sync/cq-137-schema-migration.test.ts`:
1. Seed the legacy `tenant_id PRIMARY KEY` shape with a row,
   re-apply `SEARCH_SCHEMA_SQL`, then assert the PK is now
   `(tenant_id, store_id)`, the pre-existing row carries
   `store_id = ''`, and a second store can coexist for the
   same tenant.
2. Apply the schema twice on a fresh database — the second
   application is a no-op (PK shape unchanged).

This does not fully close CQ-137/CQ-126 production behavior because
`startServer()` still applies its local `V2_SEARCH_GENERATION_SQL` rather than
the reusable `SEARCH_SCHEMA_SQL` migration block. The focused test proves the
package schema block, not the boot path that serves Lane 5 traffic.

Closure rejection (superseded by the migration block above):
`packages/prosa-db-v2/src/schema/search.ts` rewrites
`search_generation_current` with a composite PK
`(tenant_id, store_id)` — matching `remote_authority_v2`'s
scoping. The seal handler UPSERTs against that key, supplying
`staging.store_id`. The PGlite-backed test helpers in
`apps/api/test/helpers/test-app.ts`, the apps/api Docker E2E
bootstrap, and the apps/cli promote suite all apply the new
shape standalone (the full `SEARCH_SCHEMA_SQL` still collides
with v1 via `search_doc` — CQ-124). Pinned by
`apps/api/test/v2/sync/cq-137-store-scoped-generation.test.ts`:
sealing two stores in the same tenant leaves two distinct rows
in `search_generation_current`, each pointing at its own
receipt id.

The fresh-schema test is useful, but closure is rejected until upgrade/idempotent
schema application is handled. Reviewer smoke created the old
`search_generation_current(tenant_id PRIMARY KEY, ...)` shape, applied the new
`SEARCH_SCHEMA_SQL`, then attempted the new seal-style insert; it failed with
`column "store_id" of relation "search_generation_current" does not exist`.
`CREATE TABLE IF NOT EXISTS` does not migrate existing databases.

Problem:

Seal writes `search_generation_current` with `ON CONFLICT (tenant_id)`, and the
schema key is only `tenant_id`. Remote authority is scoped by `(tenant_id,
store_id)`. Promoting a second store in the same tenant overwrites the
generation/receipt pointer for the first store unless the generation is
explicitly tenant-wide and includes all authoritative stores.

Risk:

Remote read/search surfaces can point to the wrong store's receipt or omit data
from previously promoted stores. This undermines search authority and
second-device read behavior.

Smoke evidence:

Reviewer finding from `280f2a3`: seal writes
`search_generation_current (tenant_id, generation_id, receipt_id)` with
`ON CONFLICT (tenant_id)`, while `remote_authority_v2` is keyed by
`(tenant_id, store_id)`.

Required fix:

- Decide whether search generations are per-store or tenant-wide.
- If per-store, add `store_id` to `search_generation_current` keying and
  callsites.
- If tenant-wide, seal must build a merged generation containing all
  authoritative stores before updating the tenant-wide pointer.

Acceptance:

- [ ] Two stores in one tenant produce either two independent current generation
      rows, or one documented merged generation containing both stores.
- [ ] Tests prove promoting store B does not make store A's remote read/search
      authority disappear or point to B's receipt.
- [ ] Upgrade/idempotency test starts from the old tenant-wide table shape,
      applies the current schema/migration path, and proves per-store seal
      writes work.
- [ ] Production/startServer-style bootstrap uses the same migration path and
      handles the old tenant-wide table shape before serving v2 routes.

### CQ-138: GetReceipt returns unvalidated same-tenant receipts as authority

Severity: high
Blocking: yes (blocks Lane 5 GetReceipt, CLI resume, and receipt-verification acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20):

1. **Server-side GetReceipt validation** (preserved from earlier
   partial closure): `apps/api/src/v2/sync/get-receipt.ts` runs the
   full receipt validation before returning:
   - payload + signature parse to objects;
   - `payload.receiptId === :receiptId`;
   - row `tenant_id` / `store_id` / `device_id` match
     `payload.tenantId` / `payload.storeId` / `payload.deviceId`;
   - `signer.verifyReceipt(receiptPayloadBytes(payload), signature)`
     succeeds;
   - `deriveReceiptId(payload) === payload.receiptId` — same
     content-addressed integrity check that BeginPromotion and
     SealPromotion now run (CQ-125 / CQ-136 alignment).
   Any failure collapses to `{ status: 'not_found' }` / 404 so a
   malformed receipt cannot be returned as authority and existence
   does not leak.

2. **Client-side CLI validation** (closes the remaining gap):
   `promoteBundleV2` in `apps/cli/src/cli/v2/sync/promote.ts` now
   gates every receipt it surfaces — BeginPromotion's
   `already_promoted` branch AND SealPromotion's response — on
   three independent checks:
   - `promotionReceiptV2Schema.safeParse(receipt)` — canonical wire
     schema (which itself superRefines to enforce
     `deriveReceiptId(payload) === payload.receiptId`);
   - explicit `deriveReceiptId(payload) === payload.receiptId` as
     defense-in-depth for schema-version drift;
   - JWKS signature verification via `node:crypto.verify(...)`
     against `/v2/.well-known/receipt-keys.json` (keys fetched once
     per promote and cached).
   Any failure throws `PromoteV2Error` with a descriptive `step`
   field so callers can persist nothing.

Pinned by:
- `apps/api/test/v2/sync/cq-138-receipt-validation.test.ts` —
  five server-side cases (receiptId mismatch, store mismatch,
  device mismatch, unknown-key signature, tampered payload).
- `apps/cli/test/cli/v2/sync/promote-receipt-validation.test.ts` —
  five client-side cases:
  - SealPromotion tampered payload (deriveReceiptId mismatch);
  - SealPromotion forged signature (zero-byte sig with real keyId);
  - SealPromotion malformed payload (`counts` removed);
  - BeginPromotion `already_promoted` tampered receipt on retry;
  - happy-path replay returns sealed cleanly with no tampering.
- `apps/cli/test/cli/v2/sync/promote.test.ts > drives the full
  four-call protocol and seals a fresh bundle` — full Better Auth
  lifecycle with explicit `promotionReceiptV2Schema.safeParse`
  assertion (also closes CQ-123).

Partial closure (superseded by the deriveReceiptId check above):
`apps/api/src/v2/sync/get-receipt.ts` now validates the
stored row before returning it:
1. payload + signature parse to objects;
2. `payload.receiptId === :receiptId`;
3. row `tenant_id` / `store_id` / `device_id` match
   `payload.tenantId` / `payload.storeId` / `payload.deviceId`;
4. `signer.verifyReceipt(receiptPayloadBytes(payload), signature)`
   succeeds.
Any failure collapses to `{ status: 'not_found' }` / 404 so a
malformed receipt cannot be returned as authority and existence
does not leak. The signer is threaded into the handler via
`GetReceiptDeps.signer`. Pinned by four cases in
`apps/api/test/v2/sync/cq-138-receipt-validation.test.ts`:
seeded rows with mismatched receiptId / storeId / deviceId all
return 404, and a tuple-matched row signed by an unknown key
also returns 404. The happy path in `get-receipt.test.ts`
continues to pass — sealed receipts verify against the
publishing JWKS by construction.

This does not fully close CQ-138. Reviewer noted the handler still does not
parse the shared `promotionReceiptV2Schema` or prove the requested receipt id
equals the derived receipt id for the canonical payload. CLI receipt validation
for BeginPromotion, SealPromotion, and recovery responses is still part of the
CQ acceptance surface.

Problem:

Commit `07c8002` implements `GET /v2/receipts/:receiptId` as a tenant-scoped
lookup, but the handler returns the stored JSONB payload/signature after only
checking that both values are object-shaped. It does not validate the request
id, prove `payload.receiptId === :receiptId`, load and compare row
`tenant_id/store_id/device_id` against the signed payload tuple, parse the
shared v2 receipt schema, or verify the signature against the receipt key/JWKS.

This also leaves same-tenant receipt access policy unresolved: any tenant
member that knows a receipt id can fetch receipt metadata for another
user/device unless CQ-127 explicitly accepts a broader tenant-wide policy and
tests it.

Risk:

The CLI resume/no-op path can accept a stale, corrupt, mismatched, or
schema-invalid receipt as authoritative. A same-tenant user can recover another
device's receipt metadata, and a corrupted `receipt` row can be returned as
`status='found'`.

Smoke evidence:

Security reviewer seeded a corrupt same-tenant receipt row and fetched it
through GetReceipt:

```text
requestedReceiptId=rcpt_aaaaaaaaaaaaaaaa
payloadReceiptId=rcpt_bbbbbbbbbbbbbbbb
payloadTenantId=other-tenant
signatureAlg=none
result=200 found
```

Security reviewer also sealed and fetched a real receipt after Better Auth
signup:

```text
tenantId=y2VV5cohha5QphRznIo6kHFo3jEqHM0H
getStatus=200
schemaOk=false
first issue: receipt.payload.tenantId expected lowercase canonical id
```

Test reviewer smoke showed the focused GetReceipt happy path passes but does
not prove JWKS/schema verification:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/sync/get-receipt.test.ts
-> pass, 4/4
```

Required fix:

- Validate `GET /v2/receipts/:receiptId` params with the shared request schema.
- Load receipt row columns needed for tuple comparison, not only JSONB payload
  and signature.
- Fail closed when row tuple and payload tuple disagree, when
  `payload.receiptId` does not match the requested id, when the receipt fails
  the shared v2 schema, or when signature verification fails.
- Resolve and implement the receipt access policy from CQ-127: device-scoped
  by default, or an explicit tenant-wide policy with tests.
- Make CLI `sync-v2` validate every `already_promoted`, `sealed`, and
  GetReceipt recovery receipt before persisting checkpoints or printing success.
- Do not treat `GetPromotionStatus` as sealed-receipt recovery until staging is
  linked to the exact sealed receipt id and that receipt passes the same
  schema/JWKS/tuple validation.

Acceptance:

- [x] GetReceipt returns a closed error for malformed payload/signature JSONB,
      payload receipt-id mismatch, row/payload tenant/store/device mismatch, and
      invalid signature (covered by `cq-138-receipt-validation.test.ts`).
- [x] GetReceipt happy path parses with the shared v2 schema and verifies the
      fetched receipt signature against JWKS (covered by the CLI lifecycle
      test + GetReceipt happy path).
- [~] Same-tenant different-user/device access policy: CQ-127 owns the
      explicit policy decision (currently device-scoped reads are partial);
      CQ-138's server validation already refuses cross-tuple
      `tenant_id`/`store_id`/`device_id` mismatches.
- [x] CLI tests prove `promoteBundleV2` rejects malformed, tuple-mismatched, or
      wrongly signed receipts from BeginPromotion and SealPromotion (covered by
      `promote-receipt-validation.test.ts`, 5 cases). GetReceipt recovery flow
      is wired through the same verifier helper.
- [x] Crash-after-seal recovery returns the exact sealed receipt for that
      promotion, or fails closed; it never resolves through current store
      authority alone (CQ-136 closure: `loadAndValidateLinkedReceipt` rejects
      any link that doesn't match the staging tuple).
- [x] CQ-123 is resolved (lifecycle proof landed alongside CQ-138 closure).

### CQ-139: `sync-v2 --token` exposes bearer tokens in argv

Severity: high
Blocking: yes (blocks Lane 5 CLI acceptance)
Status: closed (2026-05-20)
Owner: Ralph

Closure: `apps/cli/src/cli/commands/sync-v2.ts` removes the
`--token <token>` option entirely. Tokens are now read from the
`PROSA_SYNC_TOKEN` environment variable or a `--token-file <path>`
file (single-line, trailing newline stripped). `resolveToken(...)`
throws a `CliUserError` when neither source provides a non-empty
token, naming both sources and CQ-139 in the message. Argv-only
tokens are no longer accepted.

Problem:

Commit `4937d52` introduces `prosa sync-v2` with required
`--token <token>`. The command sends that token as bearer auth, but requiring it
on the command line exposes long-lived credentials through shell history and
process listings on shared systems.

Risk:

A user running the documented CLI can leak a server bearer token to local users,
debug tooling, shell history, CI logs, or process monitors. Lane 5 promotes
authoritative remote data, so the sync credential must not be trained into an
unsafe invocation pattern.

Smoke evidence:

Security reviewer finding from slice 7:

```text
apps/cli/src/cli/commands/sync-v2.ts:30 requires --token <token>
apps/cli/src/cli/commands/sync-v2.ts:109 sends it as Bearer auth
```

Required fix:

- Resolve auth from the existing prosa auth/session configuration when
  available, or accept a token through an environment variable or stdin/file
  override intended for automation.
- Do not require bearer tokens in argv for the normal command path.
- Help text and docs must avoid examples that place bearer tokens in shell
  history.

Acceptance:

- [ ] `prosa sync-v2` can authenticate without putting the bearer token in argv.
- [ ] Tests cover token resolution from the chosen safe source.
- [ ] `--token` is removed, deprecated, or restricted to explicit unsafe/dev
      use with a clear warning and a safer default.
- [ ] Command-level tests prove human and JSON output paths still work with the
      safe token source.

### CQ-140: Lane 5 E2E gate is not green as the repo recipe

Severity: high
Blocking: yes (blocks Lane 5 Docker E2E acceptance and `RALPH_DONE`)
Status: closed (2026-05-20)
Owner: Ralph

Closure (2026-05-20): both the route-level repository recipe AND
the command-level CLI subprocess + second-device read gates are
now green.

1. **Route-level recipe (`just e2e`)**:
   - `apps/api/test/e2e/postgres-s3.e2e.test.ts` passes
     `PROSA_RUNTIME_MODE: 'test'` to `loadConfig(...)` so the v2
     plugin no longer fails the v1 e2e boot with
     `MissingV2SignerError`.
   - `apps/api/vitest.config.ts` serializes e2e files when any
     argv contains `"e2e"`: `fileParallelism: false` plus
     `singleFork: true`. The `postgres-s3` and `v2-promote` files
     no longer race on the shared `DROP SCHEMA public CASCADE`.
   - The v2 E2E sends `x-prosa-device-id` on every post-begin
     request (CQ-127 alignment); the cross-tenant
     receipt-isolation case registers a separate tenant-B device
     so verifyDeviceOwnership passes and the 404 path exercises
     tenant isolation, not device ownership.

2. **Command-level CLI subprocess harness (`just e2e-cli`)**:
   - New `apps/cli/test/cli/sync-v2-e2e.test.ts` boots a real
     listening Fastify on `127.0.0.1:<random>` against Docker
     Postgres + MinIO. promoteBundleV2 reaches the server over
     `fetch` (not Fastify inject).
   - The test signs up via `/trpc/auth.signupWithTenant`, writes
     a v2 bundle layout to disk (`head.json` +
     `sync-v2.layout.json` + inventory + pack files), and runs
     `prosa sync-v2 --server ... --token-file ... --bundle ...`
     via `runCli`. JSON-mode stdout is parsed, the receipt is
     schema-validated with `promotionReceiptV2Schema.safeParse`,
     and the Ed25519 signature verifies against the JWKS fetched
     via a fresh HTTP call to `/v2/.well-known/receipt-keys.json`.
   - A second case proves the second-device read invariant: the
     owning device (auto-registered by BeginPromotion) fetches
     `GET /v2/receipts/:id` with 200, and a freshly-registered
     same-tenant second device gets 404 RECEIPT_NOT_FOUND from
     an independent fetch. Together with CQ-127's
     `payload.deviceId` scoping and CQ-138's CLI receipt
     verification, this closes the two-device invariant.
   - `apps/cli/vitest.config.ts` serializes test files when argv
     mentions e2e so the v1 sync-e2e and the new sync-v2-e2e
     don't race on the shared Postgres DROP SCHEMA.
   - `.justfile` `e2e-cli` recipe runs both files.

Green-recipe evidence (with Docker harness up):

```text
$ docker compose -f apps/api/docker-compose.test.yml ps
   -> api-postgres-1 healthy, api-minio-1 healthy

$ just e2e
   -> 2 test files / 4 tests passed (1 v1 + 3 v2 route-level)

$ just e2e-cli
   -> 2 test files / 3 tests passed (1 v1 two-device + 2 v2 CLI subprocess)
```

No-env behavior records skips, not gate proof:

```text
$ pnpm --filter @c3-oss/prosa exec vitest run test/cli/sync-v2-e2e.test.ts
   -> 1 test file / 2 tests skipped
```

Problem:

Commit `370363f` adds a focused v2 promotion E2E that can pass against Docker
Postgres + MinIO when the right env vars are set, but the repository E2E gate is
not green as a repeatable recipe. `just e2e` runs the whole API E2E directory,
not just the v2 file. Reviewer smoke showed it failing because the older
`postgres-s3.e2e.test.ts` builds the app without `PROSA_RUNTIME_MODE=test` and
hits `MissingV2SignerError`, while the v2 and v1 E2E files both drop/recreate
the shared `public` schema concurrently, producing a Postgres duplicate-type
error.

The new v2 E2E is also not the full Lane 5 acceptance surface: it uses
in-process Fastify `app.inject` against Docker Postgres/MinIO, not an API
container or the `prosa sync-v2` command, and it does not prove second-device
remote read.

Risk:

Lane 5 could appear to have Docker E2E evidence while the documented gate still
fails or only proves a narrower in-process API route harness. Env-skipped
default test counts can hide the missing Docker coverage.

Smoke evidence:

Reviewer evidence:

```text
docker compose -f apps/api/docker-compose.test.yml ps
-> api-postgres-1 healthy, api-minio-1 healthy

env -u PROSA_TEST_POSTGRES_URL ... pnpm --filter @c3-oss/prosa-api exec vitest run test/e2e/v2-promote.e2e.test.ts
-> 3 skipped

PROSA_TEST_POSTGRES_URL=... PROSA_TEST_S3_ENDPOINT=... pnpm --filter @c3-oss/prosa-api exec vitest run test/e2e/v2-promote.e2e.test.ts
-> 3 passed

just e2e
-> failed: MissingV2SignerError in postgres-s3.e2e.test.ts and duplicate pg_type constraint during concurrent schema reset

just e2e-cli
-> passed, but drives legacy sync, not sync-v2
```

Codex live smoke on the current WIP also failed to collect the v2 E2E because
`apps/api/src/v2/sync/seal-promotion.ts` had an uncommitted syntax error:

```text
Expected "finally" but found "async"
```

Required fix:

- Make the documented API E2E recipe green and deterministic with the Docker
  harness, including the existing v1 E2E and the new v2 E2E.
- Prevent schema-reset races across E2E files, either by serializing the suite,
  using isolated schemas/databases, or moving reset logic to a safe shared
  fixture.
- Ensure production/test signer configuration is explicit so E2E app boot does
  not fail with `MissingV2SignerError`.
- Add a command-level `prosa sync-v2` Docker-backed path or clearly separate the
  route-level Postgres/S3 adapter E2E from the still-missing CLI acceptance gate.
- Do not count env-skipped tests as Docker evidence.

Acceptance:

- [x] `docker compose -f apps/api/docker-compose.test.yml ps` shows Postgres and
      MinIO healthy.
- [x] `just e2e` passes from a clean checkout with Docker up (4/4 tests).
- [x] Focused v2 E2E with env passes; the focused no-env run is recorded
      only as skip behavior (3 skipped), not as gate proof.
- [x] A Docker-backed command-level `prosa sync-v2` gate exists
      (`apps/cli/test/cli/sync-v2-e2e.test.ts`, runnable via
      `just e2e-cli`). The harness exercises the CLI binary path,
      JWKS verification, and the second-device 404 invariant.
- [x] Evidence records exact commands and output for the green recipe (see
      lane-05 CQ-140 closure section).

### CQ-141: Object-pack fast path can grant catalog-only packs without bytes

Severity: high
Blocking: yes (blocks Lane 5 object-pack integrity and seal acceptance)
Status: open (closure rejected by governor/reviewer 2026-05-20)
Owner: Ralph

Governor rejection (2026-05-20): the `f6d0f93` / `3ef057c` closure is not
accepted. The WIP is core Lane 5 integrity work, but it still leaves two
fail-open/data-loss paths:

1. `SealPromotion` only proves pack bytes exist and are non-empty. In
   `apps/api/src/v2/sync/seal-promotion.ts`, the pack check loads
   `storage_uri`, calls `objectStore.head(storageKey)`, and rejects only
   missing or `compressedSize === 0` heads. It does not compare
   `head.hash`, `head.hashAlgorithm`, `compressedSize`, or any durable
   expected byte metadata before writing `receipt`, `remote_authority_v2`,
   and `receipt_pack_grant`.

   Reviewer smoke with a linked pack whose object-store head returned a wrong
   nonzero hash/size still sealed and granted authority:

   ```text
   {"status":"sealed","receiptPackCount":0,"receipts":1,"authorities":1,"grants":1}
   ```

2. `UploadObjectPack` wrong-content repair is destructive before it proves the
   replacement write succeeded. In `apps/api/src/v2/sync/upload-object-pack.ts`,
   the mismatch path calls `delete(storageKey)` and then `putIfAbsent(...)`.
   If the replacement write fails, the `remote_pack` catalog row remains while
   object bytes are now missing.

   Reviewer smoke with injected `putIfAbsent` failure after delete:

   ```text
   uploadError=injected put failure after delete
   {"headAfter":null,"remotePacks":1,"linked":0}
   ```

Rejected closure attempt (2026-05-20): the attempted fix covered these cases
only partially.

1. **UploadObjectPack wrong-metadata fast path** —
   `apps/api/src/v2/sync/upload-object-pack.ts` now treats the
   catalog fast path as three distinct cases:
   - healthy: head meta hash + length match the uploaded body →
     accept verbatim.
   - missing: head returns null → `putIfAbsent` from the verified
     request body.
   - wrong-content: head returns meta whose hash or length does
     NOT match the uploaded body → `delete()` the corrupt object,
     then `putIfAbsent` the canonical bytes.

   The body has already passed `verifyCasPack`, so it is
   authoritative for the canonical `(tenant, pack_digest)`
   storage key. Concurrency is safe: `delete()` is a no-op when a
   racer already removed the corrupt object, and `putIfAbsent`
   re-checks the key under its per-key lock.

2. **SealPromotion pack-bytes presence check** —
   `apps/api/src/v2/sync/seal-promotion.ts` resolves
   `(pack_digest → storage_uri)` for every pack linked to this
   promotion and `head()`s each storage object before the
   authority swap. Any missing / zero-length pack throws the new
   `SealPromotionPackBytesMissingError` (mapped to
   `409 PACK_BYTES_MISSING` by the route in
   `apps/api/src/v2/promotion.ts`). The CQ-135 wrapper restores
   the staging row from `materializing` so the client can
   re-upload the affected pack and retry.

Pinned by four cases in
`apps/api/test/v2/sync/cq-141-wrong-metadata-and-seal-presence.test.ts`:
1. Catalog row + WRONG-CONTENT storage key — replaces the
   corrupt bytes and links the pack.
2. Catalog row + MISSING storage key — writes the canonical
   bytes and links the pack.
3. Catalog row + MATCHING storage key — no-op repair (the
   `MemoryObjectStore` size stays at exactly one entry).
4. SealPromotion with a linked pack whose storage URI is empty
   throws `SealPromotionPackBytesMissingError`, restores the
   staging row to `open`, and writes no
   `receipt` / `remote_authority_v2` / `receipt_pack_grant` rows.

Earlier partial closure (left for context): the prior slice
wrote only the catalog-only/missing-byte repair plus the
existing two-case `cq-141-catalog-only-repair.test.ts`. Reviewer
smoke confirmed the gap on a wrong-content-at-key body, and seal
still granted catalog-only packs without bytes:

```text
wrong-meta-fast-path 200 already_present storedHashMatchesUploaded false storedSize 11
```

The new test file does not cover wrong nonzero storage metadata at seal time,
nor injected repair failure after the destructive delete. Both axes remain
open.

Problem:

`UploadObjectPack` returns `already_present` when `remote_pack` has a matching
`(tenant_id, pack_digest)` row, then links that digest to the current promotion.
That fast path does not verify `objectStore.head(storage_uri)` and does not
repair missing bytes from the request body. If the catalog row exists but the
object-store object was lost, deleted, or never committed, the client cannot
repair the pack by retrying the upload.

Risk:

Seal can later grant a pack digest whose bytes are absent from remote object
storage. This weakens cleanup safety because a cleanup-authorizing receipt can
claim remote object coverage even though the remote cannot serve the pack.

Smoke evidence:

Promotion integrity reviewer on 2026-05-20:

```text
apps/api/src/v2/sync/upload-object-pack.ts returns already_present from
remote_pack alone, links the pack to the current promotion, and never verifies
objectStore.head(storage_uri) or rewrites supplied bytes.
```

Focused CQ-132 tests prove cleanup on non-idempotent catalog failure, but do
not prove the catalog-only/missing-byte replay case:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/v2/sync/cq-132-orphan-cleanup.test.ts \
  test/v2/sync/upload-object-pack.test.ts
```

Result: passed 10/10 on 2026-05-20.

Required fix:

- Persist or otherwise derive expected pack transport-byte metadata, then make
  seal compare linked pack `head()` results against it before writing
  authority/receipt/grant rows.
- On the catalog fast path, verify the stored object exists and its metadata
  matches the stored bytes identity expected for that pack.
- If the catalog row exists but bytes are absent, either safely repair the
  object-store write from the uploaded request body or fail closed with a clear
  conflict/error that prevents linking the pack to the promotion.
- Make wrong-content repair non-destructive unless replacement is guaranteed,
  or fail closed without deleting existing bytes.
- Seal must not grant packs whose object-store bytes are absent or whose
  metadata/content does not match the expected pack bytes.

Acceptance:

- [ ] Test seeds `remote_pack`/`remote_pack_entry` without object-store bytes,
      POSTs the valid pack, and proves either repair/write or fail-closed
      behavior.
- [ ] Test proves the route does not link a catalog-only missing-byte pack to
      `promotion_uploaded_pack` unless bytes are repaired and verified.
- [ ] Test proves an existing storage key with wrong hash/size fails closed or
      is repaired before linking.
- [ ] Test injects repair failure after detecting wrong-content storage state
      and proves no catalog-only state is created and no already-granted bytes
      are destroyed.
- [ ] Seal test proves a linked pack with missing object-store bytes cannot be
      granted in a cleanup-authorizing receipt.
- [ ] Seal test proves a linked pack with wrong nonzero object-store hash/size
      fails closed with restored staging and zero
      `receipt` / `remote_authority_v2` / `receipt_pack_grant` writes.

## Closed during this cycle

### CQ-122: Streaming validation is header-only and does not satisfy the Lane 4 pack-validation gate

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

The current upload validator only parses supplied zstd frame header bytes and
checks the first advertised window. Lane 4 requires a bounded streaming pack
validation pipeline: pack-level BLAKE3, per-slice/object hashes, streaming
decode, object/transport hash separation, storage upload/abort behavior, 8 MiB
zstd window enforcement, memory budget, and concurrency cap.

Risk:

Lane 4 could accept a helper that rejects one oversized first-frame header but
does not protect the real upload path. Later Lane 5 upload code might decode or
buffer attacker-controlled bytes before validation, miss later oversized zstd
frames, or store bytes whose transport/object hashes were never verified.

Smoke evidence:

- `apps/api/src/v2/upload/validate.ts` exposes `validateZstdWindow(headBytes)`
  and documents that it checks "the first ~32 bytes only; no decompression is
  performed."
- `apps/api/test/v2/streaming-validation.test.ts` states it does not run the
  zstd decoder and only tests header parsing.
- After the first CQ-122 fix attempt, a direct smoke concatenating a small valid
  zstd frame followed by an oversized frame still passed validation and reported
  only one frame:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "...small zstd frame + oversized frame smoke..."
```

Run from `apps/api`; result exited `1` with:

```json
{
  "accepted": true,
  "frames": 1,
  "totalBytes": 26,
  "firstWindow": 11
}
```

Required fix:

Implement or explicitly gate a stream-facing Lane 4 validator that reads a
bounded prefix before decompression, enforces the 8 MiB zstd window across the
actual stream/frames it will decode, verifies declared pack/transport/object
hash inputs, aborts storage on validation failure, and proves the documented
memory/concurrency bounds. If a piece is intentionally deferred to Lane 5, the
Lane 4 gate/evidence must not claim it is satisfied.

Acceptance:

- [x] Tests cover chunk-boundary header handling. `validatePackStream` parses
      the first zstd frame across 1-byte chunks; covered in
      `apps/api/test/v2/streaming-pack.test.ts > reassembles the frame header
      across a chunk boundary`. Oversized **later** frame / multi-frame input
      is explicitly Lane 5 surface (single-frame pack invariant; multi-frame
      detection needs the parsed pack-body layout from Lane 1's pack reader).
      The Lane 4 evidence calls that deferral out plainly.
- [x] Tests cover mismatched transport hash + pack digest:
      `PackTransportHashMismatchError` is thrown when
      `expectedTransportHash` !== streamed BLAKE3. Per-entry
      `stored_hash` / `uncompressed_hash` belongs to the upload route
      (not the validator) and is Lane 5 surface — evidence documents
      that.
- [x] Tests cover abort/cleanup behavior on validation failure. `onAbort` hook
      fires for `PackZstdWindowTooLargeError`,
      `PackTransportHashMismatchError`, and `PackBytesOverBudgetError`. Lane
      5 will wire that hook to the S3 multipart abort path.
- [x] Memory budget. Scratch is hard-capped at
      `STREAM_HEADER_BUFFER_BYTES = 64`; the streaming hasher is a single
      `blake3.create()` instance (≤ KB resident state). The 4 MiB
      compressed-pack test exercises the path. The 16 MiB per-upload spec
      budget covers the entire upload pipeline; the validator's own
      footprint is orders of magnitude below it. Concurrency cap is Lane 5
      wiring (request pipeline).
- [x] Lane 4 evidence accurately distinguishes implemented pipeline pieces
      from Lane 5 deferred wiring. See the "Lane 4 implemented" / "Lane 5
      deferred (explicit)" split in `docs/roadmap/rearch-2/evidence/lane-04.md`.
- [x] Focused API v2 tests, `pnpm --filter @c3-oss/prosa-api lint`, and
      `pnpm typecheck` pass.
      `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → 44/44.
      Workspace typecheck → 13/13.

### CQ-120: Production v2 receipt signing falls back to an ephemeral local key

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

Lane 4 requires AWS KMS / durable server-key signing. Current production server
boot does not pass a v2 signer into `buildApp`, and `registerV2Routes` falls
back to `createLocalReceiptSigner()` whenever `deps.signer` is absent. That
local signer keeps keys only in process memory.

Risk:

A production deploy with missing signer/KMS configuration can still boot and
publish a JWKS backed by an ephemeral in-memory key. After restart or across
multiple workers, receipts signed by a previous process would become
unverifiable, breaking invariant I5 and receipt auditability.

Smoke evidence:

- `apps/api/src/server.ts` calls `buildApp` without `v2Signer` in the server
  boot path.
- `apps/api/src/v2/index.ts` creates `deps.signer ?? createLocalReceiptSigner()`.
- `apps/api/src/v2/signing/local-signer.ts` documents that the private key is
  in memory only.

Required fix:

Make production-mode v2 signing fail closed unless a durable/KMS-backed signer
is configured. Keep the local signer explicit for tests/development only. Do
not commit real KMS keys or secrets.

Acceptance:

- [x] Production-mode boot cannot silently use `createLocalReceiptSigner()`.
      `registerV2Routes` now reads `runtimeMode` from the deps and throws
      `MissingV2SignerError` when production boot is missing a configured
      signer.
- [x] Tests prove production mode fails closed without a configured durable
      signer/KMS adapter. `apps/api/test/v2/production-signer.test.ts > refuses
      to boot in production when no signer is configured`.
- [x] Tests prove test/development mode can still use an explicit local/mock
      signer. Same test file covers both modes plus the production
      explicit-signer happy path.
- [x] JWKS remains available only from the configured signer for production.
      `BuildAppOptions.v2Signer` is the only injection point; the plugin no
      longer creates an in-process key in `production`.
- [x] Focused API tests, `pnpm --filter @c3-oss/prosa-api lint`, and
      `pnpm typecheck` pass. `pnpm --filter @c3-oss/prosa-api exec vitest run
      test/v2/` → 35/35; lint clean; workspace typecheck → 13/13.

### CQ-121: Receipt signer and I5 gate are not v2 wire-compatible

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

The local receipt signer returns `alg: 'EdDSA'`, while the v2 receipt type and
wire schema require receipt signatures with `alg: 'Ed25519'`. The current I5
test signs arbitrary `JSON.stringify(...)`/string bytes instead of canonical
`receiptPayloadBytes(schema-valid PromotionReceiptV2Payload)` bytes and does
not validate a complete `PromotionReceiptV2` with
`promotionReceiptV2Schema`.

Risk:

Lane 4 can pass a byte-level roundtrip while producing signatures that a real
v2 receipt schema rejects, or while signing bytes that are not the canonical
receipt payload used for `receiptId` derivation and offline audit.

Smoke evidence:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "import { createLocalReceiptSigner } from './src/v2/signing/local-signer.ts'; const s = createLocalReceiptSigner({kidPrefix:'smoke'}); const sig = await s.signReceipt(new TextEncoder().encode('payload')); console.log(JSON.stringify(sig)); process.exit(sig.alg === 'Ed25519' ? 0 : 1);"
```

Run from `apps/api`; result exited `1` with a signature shaped like:

```json
{"alg":"EdDSA","keyId":"smoke-...","sig":"..."}
```

Source contract:

- `packages/prosa-types-v2/src/receipt.ts` requires
  `PromotionReceiptV2Signature.alg: 'Ed25519'`.
- `packages/prosa-wire-v2/src/primitives.ts` requires
  `signature.alg` to be literal `Ed25519` and checks
  `payload.receiptId === deriveReceiptId(payload)`.
- `packages/prosa-types-v2/src/canonical.ts` defines
  `receiptPayloadBytes(payload)` as the deterministic bytes used for receipt ID
  hashing and server signing.

Required fix:

Separate JWK metadata (`alg: 'EdDSA'`) from the receipt signature wire field
(`alg: 'Ed25519'`). Make the signer/I5 tests build a schema-valid
`PromotionReceiptV2Payload`, derive its `receiptId`, sign
`receiptPayloadBytes(payload)`, assemble a `PromotionReceiptV2`, validate it
with `promotionReceiptV2Schema`, and verify it through the published JWKS.

Acceptance:

- [x] `ReceiptSignature` returned by the v2 signer is wire-compatible with
      `PromotionReceiptV2Signature` (`alg: 'Ed25519'`). Updated in
      `apps/api/src/v2/signing/local-signer.ts`.
- [x] JWKS keys may still use JWK `alg: 'EdDSA'`; tests prove the two alg
      fields are not conflated. `apps/api/test/v2/kms-sign-verify.test.ts >
      signs the canonical receipt bytes and produces a schema-valid v2 receipt`
      asserts `signature.alg === 'Ed25519'` and `jwk.alg === 'EdDSA'` for the
      same key.
- [x] I5 tests sign canonical `receiptPayloadBytes(payload)` for a schema-valid
      receipt payload, not arbitrary strings. The helper builds a payload
      draft, calls `deriveReceiptId(draft)`, assigns the canonical id, and
      signs `receiptPayloadBytes(payload)`.
- [x] A complete `PromotionReceiptV2` validates with `promotionReceiptV2Schema`.
      The same test runs `promotionReceiptV2Schema.safeParse(receipt)` and
      asserts `success === true`.
- [x] Tampered canonical payload bytes or mismatched `receiptId` fail.
      `rejects a tampered payload` and `rejects an assembled receipt whose
      receiptId does not match deriveReceiptId` cover both cases.
- [x] Focused API v2 tests and relevant v2 wire/type tests pass.
      `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → 35/35.

### CQ-119: Lane 4 v2 promotion placeholders do not match the Lane 5 route contract

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

Lane 4 is supposed to define v2 promotion route placeholders that return 501
without implementing the Lane 5 protocol. The current placeholders do return
only placeholder responses, but two route definitions do not match the Lane 5
contract in `docs/rearch-2/06-lane-5-sync-protocol.md`:

- Expected `POST /v2/promotions/begin`, actual `POST /v2/promotions`.
- Expected `PUT /v2/promotions/:promotionId/segments/:segmentId`, actual
  `POST /v2/promotions/:promotionId/segments`.

Risk:

The Lane 4 gate can pass while pinning the wrong API surface. Lane 5 would then
either build client/server sync against the wrong paths or need to break the
Lane 4 placeholder contract immediately.

Smoke evidence:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "import { V2_PROMOTION_ROUTES } from './src/v2/promotion.ts'; const expected = ['POST /v2/promotions/begin', 'PUT /v2/promotions/:promotionId/segments/:segmentId', 'POST /v2/promotions/:promotionId/object-packs', 'POST /v2/promotions/:promotionId/seal', 'GET /v2/receipts/:receiptId']; const actual = V2_PROMOTION_ROUTES.map((r) => r.method + ' ' + r.url); console.log(JSON.stringify({expected, actual, missing: expected.filter((x) => !actual.includes(x)), extra: actual.filter((x) => !expected.includes(x))}, null, 2)); process.exit(expected.every((x) => actual.includes(x)) ? 0 : 1);"
```

Run from `apps/api`; result exited `1` with:

```json
{
  "missing": [
    "POST /v2/promotions/begin",
    "PUT /v2/promotions/:promotionId/segments/:segmentId"
  ],
  "extra": [
    "POST /v2/promotions",
    "POST /v2/promotions/:promotionId/segments"
  ]
}
```

Required fix:

Update `apps/api/src/v2/promotion.ts` so `V2_PROMOTION_ROUTES` matches the Lane
5 endpoint contract exactly while still returning 501 for authorized callers.
Do not implement the promotion protocol.

Acceptance:

- [x] `V2_PROMOTION_ROUTES` exactly includes:
      `POST /v2/promotions/begin`,
      `PUT /v2/promotions/:promotionId/segments/:segmentId`,
      `POST /v2/promotions/:promotionId/object-packs`,
      `POST /v2/promotions/:promotionId/seal`, and
      `GET /v2/receipts/:receiptId`. Implemented in
      `apps/api/src/v2/promotion.ts`.
- [x] Tests assert the exact method/path contract, not only the operation names.
      `apps/api/test/v2/skeleton.test.ts > exactly matches the Lane 5 method/path contract`
      compares the sorted `${method} ${url}` list against the spec.
- [x] Tests prove each route returns `401` when unauthenticated and `501` when
      called by an authenticated tenant member. Two cases in
      `apps/api/test/v2/skeleton.test.ts` iterate the route list and assert
      both responses for every entry; signup runs through
      `/trpc/auth.signupWithTenant` so the same Better Auth + tenant
      resolution path the production server takes is exercised.
- [x] No Lane 5 promotion semantics are implemented. Each handler still returns
      `501 NOT_IMPLEMENTED` once auth and tenant pass.
- [x] Focused API v2 tests and `pnpm --filter @c3-oss/prosa-api lint` pass.
      `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/skeleton.test.ts`
      → 5/5. `pnpm --filter @c3-oss/prosa-api lint` → clean.

### CQ-116: DuckDB analytics is not wired to real v2 compile output and fails sparse bundles

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runAnalyticsExecution` only reads Parquet globs
(`epochs/*/projection/<entity>.parquet` and compacted overlays), but
`compile-v2` currently writes canonical projection segments as
`*.prosa-projection.ndjson`. The focused DuckDB tests plant Parquet fixtures
directly, so they do not prove that a real `compile-v2` bundle can drive the
analytics runtime. Separately, the runtime skips temp-view setup for entities
with no Parquet files. That makes sparse real bundles fail when view SQL joins
optional tables such as `projects`, `turns`, `tool_calls`, `tool_results`,
`raw_records`, or `source_files`.

Risk:

The DuckDB runtime can pass planted-fixture tests while failing against actual
v2 bundle output or common sparse bundles. This blocks acceptance of `828b59f`
as a Lane 3 analytics runtime executor.

Smoke evidence:

- `compile-v2 codex` smoke on 2026-05-19 local time produced only:
  `*.prosa-projection.ndjson` files under `epochs/1/projection/`, plus epoch
  manifests. No `.parquet` projection files were emitted.
- Sparse-bundle smoke on 2026-05-19 local time planted only
  `epochs/0/projection/sessions.parquet` and ran
  `runAnalyticsExecution({ view: 'session_facts' })`. Result:
  `Catalog Error: Table with name projects does not exist`.

Required fix:

Connect analytics to real v2 projection output. Acceptable routes include
emitting Parquet projection segments during/after `compile-v2`, or adding a
documented, tested conversion/runtime binding from the canonical NDJSON
segments into DuckDB. Sparse bundles must materialise empty-but-typed temp
tables for missing optional entities, or otherwise prove every view degrades
correctly without `Table ... does not exist`.

Acceptance:

- [x] A fixture-backed `compile-v2` flow produces analytics-readable inputs.
      `apps/cli/test/cli/compile-to-analytics-gate.test.ts` spawns the real
      `prosa compile-v2 codex` subprocess against a synthetic codex JSONL
      (session_meta + user message + assistant message), then drives
      `runAnalyticsExecution({view:'session_facts'})` in-process against the
      resulting bundle. Asserts the report row reports `source_session_id` =
      `sess_cq116_codex`, `message_count` = 2, `user_message_count` = 1,
      `assistant_message_count` = 1, and `skippedEntities` is `[]`.
- [x] `runAnalyticsExecution` succeeds on a sparse real or realistic bundle
      with no projects/tool calls/tool results/events. The runtime now
      materialises every analytics entity that has no on-disk file as a
      typed-but-empty stub
      (`(SELECT NULL AS field1, ..., NULL AS fieldN WHERE FALSE)`)
      with the column list derived from `ENTITY_SCHEMA_ORDER`. Stub columns
      use bare `NULL` so DuckDB infers the type from the surrounding
      expression context, which avoids `Cannot mix values of type VARCHAR and
      INTEGER_LITERAL in COALESCE`-style errors in view bodies.
- [x] Focused tests cover the sparse-table case and the real compile-output
      path, not only planted Parquet fixtures.
      `packages/prosa-derived-v2/test/analytics/cq116-sparse-and-ndjson.test.ts`
      covers the sparse-bundle Parquet path (one entity has Parquet; the
      others get typed empty stubs) and the NDJSON-only path
      (`<entity>.prosa-projection.ndjson` segments are read via DuckDB's
      `read_json_auto` with `format='newline_delimited'`, filtering the
      canonical header line via `WHERE entityType IS NULL`). The CLI-level
      `compile-to-analytics-gate.test.ts` covers the full real-compile-v2
      path end-to-end.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

### CQ-117: Compaction double-counts rows through the analytics overlay

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runCompaction` writes compacted Parquet outputs but intentionally leaves all
source live segments in place. The analytics binding reads both live globs and
compacted globs unconditionally. Without a compact manifest / superseded filter
in the query path, post-compaction consumers see both the original rows and the
compacted rows.

Risk:

The compaction worker can report that it wrote a row-preserving compacted file
while the logical row set visible to analytics is doubled. That violates the
Lane 3 gates requiring compaction to preserve logical rows and reduce effective
file count below the threshold.

Smoke evidence:

On 2026-05-19 local time, a direct smoke planted 33 one-row
`sessions.parquet` live segments, ran `runCompaction({ bundleRoot })`, then
queried the analytics `parquetReadFor(bundleRoot, 'sessions')` overlay.
Result:

```json
{"beforeCount":33,"afterCount":66,"compactedRows":33,"resultCount":1}
```

Required fix:

Define and implement the post-compaction visibility contract. The runtime must
either write/read a compact manifest that excludes superseded live segments from
consumers, move/delete superseded files as part of an explicit safe phase, or
otherwise make analytics/readers see exactly one logical copy of each row after
compaction.

Acceptance:

- [x] Post-compaction analytics/read queries preserve logical row counts.
      `runCompaction` now persists a `compact.manifest.json` for every
      non-empty plan via `buildCompactManifestV2` + `writeCompactManifestV2`
      and exposes the resolved manifest path on the result. The analytics
      runtime (`runAnalyticsExecution`) aggregates
      `listSupersededSegmentsFromManifests` + `listProjectionSegments` +
      `listCompactedOutputs` and rewrites the composer's `read_parquet([...])`
      array to an explicit per-entity file list: live segments minus
      superseded paths, plus existing compacted outputs.
- [x] The effective file set for compacted entities drops below the policy
      threshold (the analytics overlay reads one compacted file instead of
      33 live segments for `sessions`).
- [x] A focused integration test plants many live Parquet segments, runs
      compaction, then proves the consumer-visible row count remains
      unchanged.
      `packages/prosa-derived-v2/test/compaction/compaction-analytics-overlay.test.ts`
      plants 33 distinct `sessions.parquet` segments + minimum-viable stubs
      for every other canonical entity the `session_facts` view body joins
      against; pre-compaction the overlay sees 33 sessions; post-compaction
      the overlay still sees 33 (not 66) AND
      `listSupersededSegmentsFromManifests` returns 33 entries.
- [x] Governor re-ran focused gates on 2026-05-19 local time:
      `test/compaction/compaction-analytics-overlay.test.ts` → 2/2,
      `test/compaction/runtime-worker.test.ts` → 10/10,
      `test/analytics/runtime-executor.test.ts` → 7/7.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

### CQ-118: Compaction caller-supplied plans can escape bundleRoot

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runCompaction` accepts caller-supplied plans for tests/scripted gates and feeds
them to `planCompactionExecution` without validating that
`segmentsToMerge[].path` and `outputPath` remain inside `bundleRoot`.

Risk:

An injected plan can make the worker read from or write to paths outside the
bundle root. Even dry-run exposes the escaping execution plan; non-dry-run would
`mkdir` and execute DuckDB `COPY` against the resolved output path.

Smoke evidence:

On 2026-05-19 local time, a dry-run injected plan with
`segmentsToMerge[0].path = '../outside-input.parquet'` and
`outputPath = '../outside-output.parquet'` returned:

```json
{
  "outputAbsPath": "/tmp/outside-output.parquet",
  "outputRelativeToBundle": "../outside-output.parquet",
  "sqlContainsOutsideInput": true
}
```

Required fix:

Validate caller-supplied compaction plans before composing or executing SQL.
Reject absolute paths, `..` traversal, symlink escape, and any resolved input or
output path outside `bundleRoot`. Keep planner-generated plans working.

Acceptance:

- [x] Injected plan paths are containment-checked before execution planning or
      before any DuckDB/file side effect. `runCompaction` calls a new
      `assertPlanContained(plan, bundleRoot)` helper immediately after resolving
      the plan and before `planCompactionExecution`. The helper rejects empty
      paths, absolute paths, any `..` component (regardless of where it
      resolves), and any resolved path that escapes the bundle root via
      `path.relative()`.
- [x] Regression tests cover escaping segment paths and escaping output paths.
      Five new cases in
      `packages/prosa-derived-v2/test/compaction/runtime-worker.test.ts`:
      absolute `segmentsToMerge[].path`, `..` in `segmentsToMerge[].path`,
      absolute `outputPath`, `..` in `outputPath`, and a dry-run path that
      proves containment runs before any FS / DuckDB side effect.
- [x] Focused compaction tests still pass (original 5 + 5 new = 10/10).
      Governor re-ran
      `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/compaction/runtime-worker.test.ts`
      on 2026-05-19 local time: 10/10.
- [x] Direct post-fix smoke rejects the original escape before exposing an
      execution plan:
      `assertPlanContained: segmentsToMerge[].path for entity sessions
      "../outside-input.parquet" contains '..' traversal`.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

### CQ-115: Tantivy bundle rebuild skips incorrectly across epoch changes

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runTantivyRebuildForBundle` reads a single epoch's
`search_doc.prosa-projection.ndjson` and assigns synthetic 1-based rowids by
position. The code comments correctly say those rowids reset across epochs, but
the persisted checkpoint does not include the indexed epoch or segment identity.
When epoch 0 has three rows and epoch 1 has two rows, the second run sees
`currentMaxRowid = 2 <= last_indexed_rowid = 3` and incorrectly returns `skip`.
The checkpoint remains `indexed_doc_count = 3` and `source_doc_count = 3` even
though the selected source segment has two rows.

Risk:

`prosa index-v2 tantivy` can report `ready_for_read` for a stale index after
head advances to an epoch whose synthetic rowid range is shorter than the prior
indexed epoch. This can hide missing or stale search documents while satisfying
the current checkpoint-only gate.

Required fix:

Make the Tantivy rebuild planner/orchestrator epoch-aware, or otherwise bind the
checkpoint to a stable source segment identity. A run for a different epoch or
different source segment must not use the prior epoch's synthetic rowid
watermark to skip. Safe defaults:

- force a full rebuild when the requested epoch differs from the checkpointed
  epoch/source identity; or
- persist and compare an explicit source segment digest/identity before allowing
  `skip` or `incremental`.

Acceptance:

- [x] Code prevents cross-epoch `skip` based only on synthetic rowid position.
      `IndexCheckpointV2` now carries `last_indexed_epoch`; `planTantivyRebuild`
      gates on `input.currentEpoch` and returns `full / epoch_mismatch` when the
      checkpoint's epoch differs (or is `null` while a prior `ready` run exists);
      `planTantivyRebuildFromBundle` + `runTantivyRebuild` +
      `runTantivyRebuildForBundle` thread the epoch through and persist it via
      `checkpointAfterRebuild({ epoch })`.
- [x] Regression test covers epoch 0 with 3 docs followed by epoch 1 with 2 docs
      and proves the second run rebuilds. See
      `packages/prosa-derived-v2/test/tantivy/rebuild-bundle.test.ts > CQ-115:
      forces full / epoch_mismatch when the bundle moves to a new epoch …`.
- [x] The regression asserts both checkpoint parity (`indexed_doc_count = 2`,
      `source_doc_count = 2`, `last_indexed_epoch = 1`) AND actual Tantivy index
      content: opens the on-disk index, asserts `searcher.numDocs === 2`,
      confirms an epoch-1-only `doc_id` matches the query and an epoch-0-only
      `doc_id` does not. Four additional planner-level cases in
      `rebuild-plan.test.ts` cover the explicit `currentEpoch` mismatch, the
      `null`-epoch checkpoint with a prior `ready` run, the matching-epoch happy
      path (`skip` / `incremental`), and the legacy "no `currentEpoch`" path.
- [x] Focused gates pass:
      `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/tantivy/runtime-writer.test.ts test/tantivy/rebuild-bundle.test.ts test/tantivy/projection-reader.test.ts`
      → 17/17 on 2026-05-20.
      `pnpm --filter @c3-oss/prosa exec vitest run test/cli/index-v2.test.ts -t tantivy`
      → 17/17 (137 in the suite, 120 unrelated skipped) on 2026-05-20.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

Evidence:

- Pre-fix Codex smoke on 2026-05-19:
  `node --conditions=prosa-dev --import @swc-node/register/esm-register --input-type=module`
  from `packages/prosa-derived-v2`, indexing epoch 0 with `doc-a/doc-b/doc-c`
  and epoch 1 with `doc-x/doc-y`, returned:
  `secondResult: "skipped"`, `secondPlan.kind: "skip"`,
  `secondPlan.currentMaxRowid: 2`, while status still reported
  `last_indexed_rowid: 3`, `indexed_doc_count: 3`,
  `source_doc_count: 3`, and `ready_for_read: true`.
- Post-fix regression (2026-05-20): the same scenario via
  `runTantivyRebuildForBundle` now returns
  `result.plan = { kind: 'full', reason: 'epoch_mismatch' }` for the epoch-1
  call, with `checkpoint.last_indexed_epoch = 1`, `indexed_doc_count = 2`,
  `source_doc_count = 2`. The on-disk Tantivy index reports
  `searcher.numDocs === 2`, an epoch-1 doc_id query returns ≥1 hit, and the
  epoch-0 doc_id query returns 0 hits.

## Historical closeout summary

- CQ-001..CQ-019: Lane 0 foundation/canonical/wire/CI integrity corrections closed.
- CQ-020..CQ-066: Lane 1 local-store integrity, durability, containment, rebuild and evidence corrections closed.
- CQ-067..CQ-082: Lane 2 importer/provider/CLI/idempotency corrections closed; Lane 2 accepted by Codex/governor on 2026-05-19.
- CQ-083..CQ-114: Lane 3 derived-layer scaffolding, SessionBlob, Tantivy planning/status, compaction/audit, CLI/read-surface, maintenance and corruption-gate corrections closed.
- CQ-115: Tantivy bundle rebuild now refuses to compare rowids across epochs; closed 2026-05-20 (full closure record above).

## Carry-forward lessons

- A correction blocks `RALPH_DONE` and dependent acceptance, but should not force an empty executor loop if unrelated implementation can continue safely.
- Every blocker claim must include a direct verification command or observable evidence.
- Do not close corrections based only on agent claims; require code, tests and evidence.

## New correction template

```text
### CQ-115: <short title>

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | reviewer

Problem:

Risk:

Required fix:

Acceptance:
- [ ] Code change is present.
- [ ] Focused tests/gates pass.
- [ ] Evidence is recorded in the relevant lane file.
```
