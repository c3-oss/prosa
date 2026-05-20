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

Lane 5 Sync protocol is not complete until all of these are true:

- `POST /v2/promotions/begin` implements the no-op fast path and staging path
  without widening tenant scope.
- Inventory and object-pack uploads validate transport hashes separately from
  canonical BLAKE3 object identity and abort/cleanup on failure.
- `SealPromotion` performs the load-bearing authority swap transactionally:
  receipt insert, `remote_authority_v2`, `search_generation_current`,
  `receipt_pack_grant`, and sealed staging status.
- `GET /v2/receipts/:receiptId` is tenant-scoped and verifies against JWKS.
- `prosa sync-v2` promotes a fresh bundle, resumes after interrupt, supports
  `--no-resume`, and repeats the same bundle in under 2 seconds.
- Invariants I1, I2, I3, I4, and I5 pass for the promotion path.
- Lint rule or equivalent test proves only the seal path writes authority
  tables: `remote_authority_v2`, `search_generation_current`, and
  `receipt_pack_grant`.
- Docker-backed E2E covers API, Postgres, object storage, CLI sync, and a second
  device reading remotely.

Minimum command evidence:

```text
pnpm --filter @c3-oss/prosa-api test
pnpm --filter @c3-oss/prosa test
pnpm typecheck
pnpm lint
git diff --check
```

## Known historical notes

- Audit output previously had 8 findings, all pre-existing on `master`; only `apps__cli>ink>ws` touched a non-dev path.
- `compile-v2 --help` subprocess tests have shown intermittent timeout flake under high turbo parallelism; isolated runs passed in the overnight wrap-up.
- The native runtime dependencies are available; do not treat `allowBuilds` as a blocker without a fresh failing smoke test.
