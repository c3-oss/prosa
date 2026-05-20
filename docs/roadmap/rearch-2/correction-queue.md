# rearch-2 Correction Queue

Updated: 2026-05-20 after Lane 5 slice 1.

## Open blocking corrections

### CQ-123: Better Auth tenant_id values do not satisfy `canonicalIdSchema`

Severity: high
Blocking: yes (blocks Lane 5 acceptance — receipt schema cannot be parsed by clients)
Status: open
Owner: Ralph

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

- [ ] A real Better Auth signup produces tenant/store/device ids that
      either match the v2 canonical schema or pass the relaxed
      auth-id schema, and a receipt signed by the server passes
      client-side `promotionReceiptV2Schema.safeParse`.
- [ ] End-to-end test covers the full lifecycle:
      signup → BeginPromotion → uploads → seal → GetReceipt → client
      verifies signature against JWKS.
- [ ] Lane 5 slice 1 test re-enables
      `beginPromotionResponseSchema.safeParse` assertions removed in
      this slice.

### CQ-124: v1 and v2 schemas share table names with incompatible columns

Severity: high
Blocking: no (does not block Lane 5 development; blocks Lane 10 cutover)
Status: open
Owner: Ralph

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
