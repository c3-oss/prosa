# `bench/`

Ad-hoc performance benchmarks for prosa subsystems. Not part of the test suite;
run manually against a real bundle when investigating regressions or tuning
work. Produce raw numbers cited in `docs/roadmap/*-perf.md`.

## Layout

- `bench-tantivy.ts` — Tantivy full-rebuild + incremental indexing comparison
  across thread/memory configurations. Reads `search_docs` from a snapshot of
  `~/.prosa/prosa.sqlite` at `/tmp/prosa-bench.sqlite`.
- `bench-parquet.ts` — Parquet `COPY` benchmark across compression and row-group
  variants for the six largest tables. Writes into `/tmp/prosa-bench-parquet/`.
- `bench-parquet-read.ts` — Read-side latency comparison between the parquet
  variants produced by `bench-parquet.ts`.

## How to run

1. Take a snapshot so the live bundle isn't churned:

   ```sh
   cp ~/.prosa/prosa.sqlite /tmp/prosa-bench.sqlite
   ```

2. Run a benchmark with `swc-node` (no build step needed):

   ```sh
   node --import @swc-node/register/esm-register bench/bench-tantivy.ts
   node --import @swc-node/register/esm-register bench/bench-parquet.ts
   node --import @swc-node/register/esm-register bench/bench-parquet-read.ts
   ```

3. Clean up after:

   ```sh
   rm -rf /tmp/prosa-bench.sqlite /tmp/prosa-bench /tmp/prosa-bench-parquet
   ```

## Conventions

- Each script must be standalone (no shared imports across `bench/`).
- Hard-coded paths live at the top of each script; rewrite if your bundle
  lives elsewhere.
- Numbers should be reproducible on the same hardware; record CPU and bundle
  size in any results doc that cites them.
