# rearch-2 Gates

Updated: 2026-05-19 after cycle reset.

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

## Known historical notes

- Audit output previously had 8 findings, all pre-existing on `master`; only `apps__cli>ink>ws` touched a non-dev path.
- `compile-v2 --help` subprocess tests have shown intermittent timeout flake under high turbo parallelism; isolated runs passed in the overnight wrap-up.
- The native runtime dependencies are available; do not treat `allowBuilds` as a blocker without a fresh failing smoke test.
