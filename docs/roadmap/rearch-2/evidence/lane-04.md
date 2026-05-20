# Lane 4 Evidence - Server

Status: in progress. v2 plugin scaffold landed (slice 2/6). Implementation not yet accepted.

Lane 4 may start only after Lane 3 closeout is clean and the five 180-second
stabilization cycles are documented. The current core milestone is the server
foundation from `docs/rearch-2/05-lane-4-server.md`.

Core scope:

- `packages/prosa-db-v2` schema and idempotent `applySchemaV2` with required
  table boot checks.
- `apps/api/src/v2/` production-mode boot skeleton under preserved Better Auth
  context.
- Receipt signing/JWKS with local/mock signer test coverage and no real
  secrets.
- Bounded streaming pack validation with zstd window rejection.
- `apps/api/src/cron/` advisory-lock skeleton only.
- v2 promotion route definitions returning 501.

Blocked as Lane 5+:

- Working `BeginPromotion`, upload, seal, `GetReceipt`, `prosa sync-v2`,
  resume/checkpoint behavior, remote reads, and audit/GC implementation.

Evidence to record during implementation:

```text
pnpm --filter @c3-oss/prosa-db-v2 test
pnpm --filter @c3-oss/prosa-api test
pnpm typecheck
pnpm lint
git diff --check
```

Required smokes:

- Production-mode API boot against local Postgres plus S3/MinIO or a documented
  test adapter.
- JWKS curl returns a valid key set.
- Invariant I5 signing roundtrip passes.
- `applySchemaV2` is idempotent.
- v2 promotion routes exist and return 501.

## Slice 1 (db-v2 reconciliation) — landed before this cycle

- `packages/prosa-db-v2/src/apply.ts` already provides `applySchemaV2`
  (idempotent via `CREATE ... IF NOT EXISTS` blocks) and
  `assertSchemaV2` (throws `SchemaCheckError` listing missing tables).
- `REQUIRED_TABLES` covers `device`, `promotion_staging`,
  `remote_authority_v2`, `receipt`, `remote_pack`, `remote_pack_entry`,
  `remote_object`, `receipt_pack_grant`, `projection_session`,
  `projection_message`, `projection_tool_call`,
  `projection_tool_result`, `projection_event`,
  `projection_content_block`, `projection_artifact`,
  `projection_edge`, `projection_project`, `projection_raw_record`,
  `projection_source_file`, `projection_turn`, `search_doc`,
  `search_generation_current`.
- Schema files under `packages/prosa-db-v2/src/schema/` define every
  table listed in `docs/rearch-2/05-lane-4-server.md` task 1, plus
  `legacy_receipt_archive` (under `promotion.ts`) and `remote_object`
  (under `packs.ts`).
- Gate: `pnpm --filter @c3-oss/prosa-db-v2 test` → 6/6 (idempotency,
  required-table coverage, drop-table failure, JSONB roundtrip,
  `to_tsvector` indexing, etc.).

## Slice 2 (v2 plugin scaffold + signer + JWKS + 501 routes) — 2026-05-20

- New `apps/api/src/v2/` directory:
  - `context.ts` — `resolveV2AuthContext` mirrors the v1 tRPC context
    rules (Better Auth session → tenant via the `member` table; header
    `x-prosa-tenant-id` takes precedence over the active organization
    on the session).
  - `signing/local-signer.ts` — `createLocalReceiptSigner` generates
    an in-process Ed25519 key on boot, exposes `signReceipt`,
    `verifyReceipt`, `publishJwks`, and `rotateCurrentKey`. Historical
    keys remain in the JWKS forever after rotation (infinite
    retention, per the spec).
  - `keys.ts` — registers `GET /v2/.well-known/receipt-keys.json`,
    returns `application/jwk-set+json`.
  - `promotion.ts` — registers `POST /v2/promotions`,
    `POST /v2/promotions/:promotionId/segments`,
    `POST /v2/promotions/:promotionId/object-packs`,
    `POST /v2/promotions/:promotionId/seal`, and
    `GET /v2/receipts/:receiptId`. Each route resolves the v2 auth
    context; unauthenticated → `401 UNAUTHENTICATED`,
    authenticated-without-tenant → `403 TENANT_REQUIRED`, otherwise
    `501 NOT_IMPLEMENTED` (Lane 5 surface).
  - `index.ts` — `registerV2Routes(app, deps)` wires both routes;
    accepts an optional pre-built signer (production-mode boot will
    pass a KMS-backed implementation when that lands).
- `apps/api/src/app.ts` — `buildApp` now calls `registerV2Routes`
  with the same auth/db handles as the v1 surface. No v1 behavior
  changed.
- New `apps/api/test/v2/skeleton.test.ts` — exercises:
  1. JWKS endpoint returns `application/jwk-set+json` with at least
     one current EdDSA/Ed25519/sig key with non-empty `kid` and `x`.
  2. Every promotion route returns `401 UNAUTHENTICATED` to
     unauthenticated callers (covers all five route definitions).
  3. `V2_PROMOTION_ROUTES` enumerates the five Lane 5 op names.
- Gates (focused):
  - `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/skeleton.test.ts` → 3/3.
  - `pnpm --filter @c3-oss/prosa-api test` → 138 passed, 1 skipped (no regressions in v1 surface).
  - `pnpm --filter @c3-oss/prosa-api lint` → clean.
  - Workspace `pnpm typecheck` → 13/13.

## Slice 3 (invariant I5 sign+verify gate) — 2026-05-20

- Pre-existing bug fixed in `apps/api/src/v2/signing/local-signer.ts`:
  `publicJwkToKeyObject` was calling `createPrivateKey` against a
  public JWK; switched to `createPublicKey`. Without this, rotation
  verification failed because the helper was only used on the
  historical/look-up path (the current entry kept its full
  `privateKey` KeyObject and dodged the bug).
- New `apps/api/test/v2/kms-sign-verify.test.ts` exercises invariant
  I5 across six cases:
  1. Sign + verify roundtrip — `keyId` matches `currentKeyId()`,
     signature is non-empty base64url, the kid appears in `publishJwks`,
     and `verifyReceipt(payload, sig)` is `true`.
  2. Tampered payload — same key, mutated bytes → `false`.
  3. Cross-signer rejection — signature from `signerB` does not
     verify on `signerA` (unknown kid).
  4. Rotation — old kid stays in JWKS, both old and new receipts
     verify against the same signer instance after rotation, the new
     kid is reported by `currentKeyId()`.
  5. Unknown kid in signature → `false`.
  6. Non-EdDSA `alg` field → `false`.
- Gates:
  - `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → 9/9
    (skeleton + sign-verify).
  - `pnpm --filter @c3-oss/prosa-api lint` → clean.
  - Workspace `pnpm typecheck` → 13/13.
- Invariant I5 gate is satisfied for the local signer adapter.
  Production-mode boot still needs a KMS-backed implementation; that
  is a Lane 4 task 4 follow-up. The `ReceiptSigner` interface and the
  `BuildAppOptions.v2Signer` hook allow KMS to drop in without
  changing any caller.

## CQ-119 closure — 2026-05-20

- Updated `apps/api/src/v2/promotion.ts` so `V2_PROMOTION_ROUTES`
  matches the Lane 5 contract exactly:
  - `POST /v2/promotions/begin`
  - `PUT /v2/promotions/:promotionId/segments/:segmentId`
  - `POST /v2/promotions/:promotionId/object-packs`
  - `POST /v2/promotions/:promotionId/seal`
  - `GET /v2/receipts/:receiptId`
  All five routes still return `501 NOT_IMPLEMENTED` once the auth
  ladder passes; no Lane 5 promotion semantics are implemented.
- Strengthened `apps/api/test/v2/skeleton.test.ts`:
  - Added `exactly matches the Lane 5 method/path contract` — asserts
    the sorted `${method} ${url}` list against the spec verbatim.
  - Added `returns 501 NOT_IMPLEMENTED to an authenticated tenant
    member on every promotion route` — signs up through
    `/trpc/auth.signupWithTenant` so Better Auth + tenant resolution
    is exercised end-to-end, then injects each route with the
    issued Bearer token and asserts `501 NOT_IMPLEMENTED` with the
    `Lane 5` message.
  - Preserved the original 401-unauthenticated case; the route loop
    now also substitutes `:segmentId` so `PUT
    /v2/promotions/:promotionId/segments/:segmentId` is reachable
    in the test.
- Gates:
  - `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/skeleton.test.ts` → 5/5.
  - `pnpm --filter @c3-oss/prosa-api lint` → clean.
  - Workspace `pnpm typecheck` → 13/13.

## Slice 4 (zstd window cap) — 2026-05-20

- New `apps/api/src/v2/upload/validate.ts` parses the zstd frame
  header directly (RFC 8478 §3.1) to recover the advertised window
  size without invoking the decoder. `validateZstdWindow(headBytes,
  opts)` throws `PackZstdWindowTooLargeError` (code
  `PACK_ZSTD_WINDOW_TOO_LARGE`, action `reencode_pack`) when the
  declared window exceeds `DEFAULT_MAX_ZSTD_WINDOW_BYTES = 8 MiB`
  (or a caller-supplied tighter cap). The parser handles both the
  Window_Descriptor and the Single_Segment+FCS code paths.
- New `apps/api/test/v2/streaming-validation.test.ts` covers 10
  cases:
  - parses a real zstd-napi default-window pack (magic + summary
    sane);
  - accepts a single-segment zstd-napi frame whose `window ==
    content_size` < cap;
  - decodes synthesised `Window_Descriptor (exp 13, mant 0)` as
    exactly 8 MiB and allows it (strict `>` boundary);
  - rejects synthesised `Window_Descriptor (exp 14, mant 0)` = 16
    MiB with `PACK_ZSTD_WINDOW_TOO_LARGE` and `action:
    'reencode_pack'`;
  - rejects synthesised `Window_Descriptor (exp 17, mant 0)` = 128
    MiB;
  - rejects synthesised `Window_Descriptor (exp 13, mant 1)` = 9
    MiB (mantissa effect);
  - honors a tighter caller-supplied cap against a real zstd-napi
    single-segment frame;
  - throws `ZSTD_BAD_MAGIC` for non-zstd bytes;
  - throws `ZSTD_HEADER_TRUNCATED` for under-sized input;
  - reports the canonical magic constant `0xfd2fb528`.
- Hand-crafted frame headers are required because zstd-napi prefers
  Single_Segment frames for the small payloads a unit test can
  afford. Single_Segment frames carry no Window_Descriptor, so to
  exercise the `Window_Descriptor (exp, mant)` parse path the test
  synthesises the header bytes directly. The validator never decodes
  the body, so the synthesised frames are valid input for the parser.
- Gates:
  - `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → 19/19.
  - `pnpm --filter @c3-oss/prosa-api lint` → clean.
  - Workspace `pnpm typecheck` → 13/13.

## Slice 5 (cron advisory-lock skeleton) — 2026-05-20

- New `apps/api/src/cron/advisory-lock.ts`:
  - `hashLockNameToInt64(name)` hashes the role name through SHA-256
    and reads the first 8 bytes as a signed big-endian int64.
  - `withAdvisoryLock(rawExec, lockName, fn)` calls
    `pg_try_advisory_lock($1)` (non-blocking), runs `fn()` only on
    success, releases via `pg_advisory_unlock($1)` on every exit
    path (including when `fn` throws). Returns
    `{ acquired: true, result }` or `{ acquired: false, result: null }`.
- New `apps/api/src/cron/index.ts`:
  - `CRON_TASK_DEFINITIONS` enumerates the 4 audit roles + 1 GC role
    per the Lane 4 spec with cron expressions
    `0 * * * *` / `0 2 * * *` / `0 3 * * 0` / `0 4 1 * *` /
    `0 1 * * *` and lock names `prosa-audit-hourly`/`-daily`/
    `-weekly`/`-monthly`/`prosa-gc-daily`.
  - `startCron({ rawExec, scheduler, handlers? })` registers each
    task with the injected `scheduler(cronExpression, wrapped)` and
    always wraps the body in `withAdvisoryLock(lockName, body)`.
    Production-mode boot will pass `node-cron`'s `cron.schedule`;
    tests inject a recording scheduler. The default `noopHandler`
    runs under the lock so the contract is exercised before Lane 8
    fills in the real bodies.
- New `apps/api/test/v2/cron-advisory-lock.test.ts` covers 7 cases:
  1. `startCron` registers exactly one job per definition; `cancel`
     removes them.
  2. Role list has 4 audit + 1 gc entries.
  3. `withAdvisoryLock` against a real PGlite acquires + releases
     and a second call also succeeds.
  4. Stubbed contention (first try → false) skips the handler.
  5. Lock is released when the handler throws.
  6. Recording scheduler + per-task counters: 2 ticks each → 2
     increments each (proves lock is released between ticks).
  7. `hashLockNameToInt64` is deterministic and produces distinct
     ids per name.
- Note: PGlite advisory locks are per-instance, so the cross-session
  contention case uses a stub rawExec rather than a sibling PGlite.
  The contract under test matches what a real cross-session PG
  caller would observe.
- Lane 8 audit/GC handlers are intentionally NOT implemented here.
- Gates:
  - `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/` → 28/28.
  - `pnpm --filter @c3-oss/prosa-api lint` → clean.
  - Workspace `pnpm typecheck` → 13/13.

## Governor review - CQ-120/CQ-121/CQ-122 opened

CQ-119 was closed by `957d132`; the route contract smoke now passes and API v2
tests pass. Three new Lane 4 blockers remain open:

- CQ-120: production v2 signing must not fall back to an ephemeral local signer.
- CQ-121: receipt signatures/I5 tests must use the v2 wire algorithm and
  canonical receipt payload bytes.
- CQ-122: streaming validation must satisfy the full Lane 4 pack-validation gate
  or stop claiming deferred pieces are complete.

Focused validation observed during review:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "...V2_PROMOTION_ROUTES exact method/path smoke..."
```

Run from `apps/api`; result: pass, with no missing or extra routes.

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "...createLocalReceiptSigner alg smoke..."
```

Run from `apps/api`; result: fail because the signer returns `alg: "EdDSA"`
where the v2 receipt schema requires `alg: "Ed25519"`.

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/
```

Result: pass, 28/28.
