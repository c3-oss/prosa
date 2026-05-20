# rearch-2 Gates

Updated: 2026-05-20 after Lane 4 final gate batch.

## Baseline gates for the next cycle

Run these before claiming any new slice is complete:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm lint
git diff --check
```

Focused gates should be added for the package touched by the slice, especially:

```text
pnpm --filter @c3-oss/prosa-derived-v2 typecheck
pnpm --filter @c3-oss/prosa-derived-v2 test
pnpm --filter @c3-oss/prosa-derived-v2 lint
pnpm --filter @c3-oss/prosa exec vitest run test/cli/index-v2.test.ts
```

## Lane 3 completion gates

Lane 3 is not complete until all of these are true:

- Tantivy runtime writer/rebuild has an end-to-end gate proving the index reaches `ready` and `indexed_doc_count == source_doc_count`.
- DuckDB analytics runtime has an end-to-end gate proving the fixed reports execute against v2 Parquet and match expected counts.
- Parquet compaction merge worker has a scripted 100-small-epoch scenario proving compaction reduces file count while preserving logical rows.
- Transcript rendering against a v2 bundle matches the v1 renderer for the same input.
- No open blocking corrections remain.
- Final stabilization is optional when no useful Ralph work remains. If
  Codex/governor explicitly requests stabilization, complete the requested clean
  cycles before `RALPH_DONE`; otherwise stop for governor acceptance once all
  CQs/gates/evidence are clean.

## Lane 4 completion gates

Lane 4 Server is not complete until all of these are true:

- `packages/prosa-db-v2` schema and `applySchemaV2` are idempotent, and
  required-table checks fail boot when a load-bearing table is missing.
- `apps/api/src/v2/` boots in production-mode config with preserved Better Auth
  context for `/v2/*`.
- Server receipt signing and verification satisfy invariant I5, using local/mock
  signing in tests and no committed real secrets.
- `/v2/.well-known/receipt-keys.json` returns valid JWKS with current and
  historical key support.
- Streaming pack validation rejects zstd windows larger than 8 MiB and enforces
  the documented memory budget.
- Cron/advisory-lock skeleton exists, but Lane 8 audit/GC behavior is not
  implemented.
- v2 promotion route definitions exist and return 501; working promotion
  protocol remains Lane 5.

Minimum command evidence:

```text
pnpm --filter @c3-oss/prosa-db-v2 test
pnpm --filter @c3-oss/prosa-api test
pnpm typecheck
pnpm lint
git diff --check
```

Final governor run on 2026-05-20:

- `pnpm --filter @c3-oss/prosa-db-v2 test` -> pass, 6/6.
- `pnpm --filter @c3-oss/prosa-api test` -> pass, 179 passed / 1 skipped.
- `pnpm typecheck` -> pass, 13/13 packages.
- `pnpm lint` -> pass, 13/13 packages.
- `pnpm build` -> pass, 13/13 packages.
- `git diff --check` -> pass.

Lane 4 still requires five fresh clean 180-second stabilization cycles before
acceptance.

## Lane 5 completion gates

Lane 5 Sync protocol is functionally complete; the gate checklist is:

- [x] L5.1 — `POST /v2/promotions/begin` implements the no-op fast path and
  staging path without widening tenant scope. (CQ-125, CQ-128.)
- [x] L5.2 — Inventory and object-pack uploads validate transport hashes
  separately from canonical BLAKE3 object identity and abort/cleanup on
  failure. (CQ-129, CQ-130, CQ-132 accepted; CQ-141 accepted after closure
  attempt #4.)
- [x] L5.3 — `SealPromotion` performs the load-bearing authority swap
  transactionally: receipt insert, `remote_authority_v2`,
  `search_generation_current`, `receipt_pack_grant`, and sealed staging
  status. (Slice 5 + CQ-135 + CQ-136 + CQ-137 accepted; CQ-141 accepted for
  pack-byte metadata proof before authority grant and sealed replay.)
- [x] L5.4 — `GET /v2/receipts/:receiptId` is device-scoped (CQ-127) and
  verifies against JWKS (CQ-138 server side + CQ-123 + CQ-138 client side).
- [x] L5.5 — `prosa sync-v2` promotes a fresh bundle, resumes after
  interrupt, supports `--no-resume`, and repeats the same bundle via the
  `already_promoted` fast path. (Existing slice 7/8 + new L5.6 flag.)
- [x] L5.6 — `--no-resume` flag implemented (commander `--no-resume` →
  `PromoteInput.skipResume`) and pinned by
  `promote.test.ts > --no-resume (skipResume: true) skips the GET /status call`.
- [x] L5.7 — Test proves only the seal path writes authority tables:
  `apps/api/test/v2/sync/seal-only-authority.test.ts` walks `apps/api/src`
  and asserts only `seal-promotion.ts` contains
  `INSERT/UPDATE remote_authority_v2|search_generation_current|receipt_pack_grant`.
- [x] L5.8 — Invariants I1, I2, I3, I4, and I5 pass for the promotion path
  (covered across CQ-123, CQ-125, CQ-127, CQ-138 tests + JWKS verify in
  `promote.test.ts > drives the full four-call protocol`).
- [x] L5.9 — Docker-backed E2E covers API, Postgres, object storage, CLI
  sync, and a second device reading remotely. (`just e2e` 4/4 + `just
  e2e-cli` 3/3, including `apps/cli/test/cli/sync-v2-e2e.test.ts`.)

Outstanding (deferred to Lane 10): CQ-124 v1/v2 schema cutover and the
CQ-124-blocked portions of CQ-134 (projection / search materialization).
These are NOT Lane 5 scope per the initial plan — Lane 5 uses the
`applyV2PromotionSubsetSchema` workaround.

Governor acceptance after Ralph finalization (2026-05-20): L5.2 and L5.3 are
accepted. Closure attempt #4 was reviewed and accepted by Codex/governor. In
addition to closure attempt #3 (durable `remote_pack.byte_hash` + seal
hash/algorithm/length verification + non-destructive upload), attempt #4 makes
the `status='sealed'` and race-loser replay branches re-run linked-pack byte
verification before returning the existing receipt, and adds route-level
(Fastify HTTP injection) evidence for 409 `PACK_BYTES_CORRUPT`, 409
`PACK_BYTES_MISMATCH`, and both sealed-replay failure modes. Pinned by 14
focused cases across
`apps/api/test/v2/sync/cq-141-wrong-metadata-and-seal-presence.test.ts`
(10 unit) and
`apps/api/test/v2/sync/cq-141-route-409-and-sealed-replay.test.ts`
(4 route/replay).

Minimum command evidence:

```text
pnpm --filter @c3-oss/prosa-api test   # 282/4 skipped (env-gated E2E + 1 pre-existing)
pnpm --filter @c3-oss/prosa test       # 295+/3 skipped (sync-v2-e2e + pre-existing)
pnpm typecheck                         # 13/13
pnpm lint                              # 13/13
git diff --check                       # clean
just e2e                               # 4/4 with Docker up
just e2e-cli                           # 3/3 with Docker up
```

Lane 5 is accepted by Codex/governor on 2026-05-20. CQ-124 and the remaining
CQ-124-blocked CQ-134 projection/search materialization work remain Lane 10
scope and are not silently accepted here.

## Lane 6 completion gates

Lane 6 Read API is the next active milestone. Initial gate checklist:

- [x] L6.1 — `GET /v2/stores/:storeId/authority` returns
  `unchanged | updated | gone_or_forbidden`, verifies tenant/store authority,
  and pins the 30 s cache TTL behavior. (`authority-refresh.test.ts`.)
- [x] L6.2 — Sessions list/count/detail/transcript reads are receipt-pinned,
  tenant scoped, cursor-stable, and fail closed for unverified rows.
  (`sessions-list.test.ts`, `transcript-pagination.test.ts`,
  `cursor-snapshot.test.ts`, `cursor-integrity.test.ts`,
  `cursor-route-integrity.test.ts`.)
- [x] L6.3 — Search query uses Postgres FTS with role/tool/type/error filters,
  snippets, stable cursors, and verified-authority gating.
  (`search-fts.test.ts`.)
- [x] L6.4 — Tool-calls list and artifacts.getText enforce verified projection
  plus receipt/object grants; large/binary artifact behavior is bounded.
  (`tool-calls-list.test.ts`, `artifacts-get-text.test.ts`,
  `artifacts-route.test.ts`.)
- [x] L6.5 — Analytics summary/report expose the fixed report contracts from
  Lane 3-equivalent shapes without widening tenant scope. Strict input
  pinned by `analytics-report.test.ts` + `analytics-route.test.ts`.
- [x] L6.6 — Cross-store aggregation returns one row per logical session using
  deterministic conflict resolution. `picked_sessions` CTE pinned by
  `cross-store-distinct.test.ts`; slice 11 adds the wrong-session tuple
  match regression.
- [x] L6.7 — No read path bypasses the shared verified-projection/authority
  gate; `lint-no-direct-projection-read.test.ts` walks
  `src/v2/reads/` and rejects any new handler that mentions a
  `VERIFIED_PROJECTION_TABLES` entry without composing the helper.
- [x] L6.8 — Performance evidence records p95 targets for sessions list,
  search, transcript first page, and artifacts.getText.
- [x] L6.9 — `pnpm --filter @c3-oss/prosa-api test`, `pnpm typecheck`,
  `pnpm lint`, and `git diff --check` are clean (slice 11 contributor
  checkout: 422 passed / 4 skipped on the api filter, 13/13 typecheck,
  13/13 lint, `git diff --check` empty).

## Known historical notes

- Audit output previously had 8 findings, all pre-existing on `master`; only `apps__cli>ink>ws` touched a non-dev path.
- `compile-v2 --help` subprocess tests have shown intermittent timeout flake under high turbo parallelism; isolated runs passed in the overnight wrap-up.
- The native runtime dependencies are available; do not treat `allowBuilds` as a blocker without a fresh failing smoke test.
