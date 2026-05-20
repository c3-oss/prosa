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
- Final stabilization completes five clean cycles before `RALPH_DONE`.

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
- [ ] L5.2 — Inventory and object-pack uploads validate transport hashes
  separately from canonical BLAKE3 object identity and abort/cleanup on
  failure. (CQ-129, CQ-130, CQ-132 accepted; CQ-141 reopened.)
- [ ] L5.3 — `SealPromotion` performs the load-bearing authority swap
  transactionally: receipt insert, `remote_authority_v2`,
  `search_generation_current`, `receipt_pack_grant`, and sealed staging
  status. (Slice 5 + CQ-135 + CQ-136 + CQ-137 accepted; CQ-141 reopened for
  pack-byte metadata proof before authority grant.)
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

Governor rejection after Ralph finalization (2026-05-20): L5.2 and L5.3 are
not accepted while CQ-141 remains open. The previous CQ-141 closure proves
missing pack bytes fail closed, but not wrong nonzero object-store metadata at
seal time, and the wrong-content upload repair can delete existing bytes before
replacement succeeds.

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

## Known historical notes

- Audit output previously had 8 findings, all pre-existing on `master`; only `apps__cli>ink>ws` touched a non-dev path.
- `compile-v2 --help` subprocess tests have shown intermittent timeout flake under high turbo parallelism; isolated runs passed in the overnight wrap-up.
- The native runtime dependencies are available; do not treat `allowBuilds` as a blocker without a fresh failing smoke test.
