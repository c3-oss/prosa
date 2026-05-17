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
- `bench-sync-docker.ts` — end-to-end sync timing harness for a copied local
  bundle against the Docker/API server. It records dry-run, cold sync, and warm
  re-sync JSON metrics without touching the source store.
- `bench-sync-phase-probe.ts` — synthetic in-process API sync probe using
  PGlite and memory storage. It records per-phase wall time, raw SQL counts,
  top sync SQL, object-store calls, a cold promotion, an idempotent commit
  replay, and a warm re-promotion. Use it for query-amplification visibility,
  not final Docker/Postgres/MinIO throughput claims.

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

   Synthetic sync phase probe:

   ```sh
   TS_NODE_PROJECT=apps/api/tsconfig.json \
   node --import @swc-node/register/esm-register \
     bench/bench-sync-phase-probe.ts \
     --objects 100 --sessions 50 \
     --output /tmp/prosa-sync-phase-probe.json
   ```

   Sync benchmark against an already running API:

   ```sh
   node --import @swc-node/register/esm-register bench/bench-sync-docker.ts \
     --source-store ~/.prosa \
     --server http://127.0.0.1:3000 \
     --output /tmp/prosa-sync-bench.json
   ```

   Or let the script manage the root Docker compose stack:

   ```sh
   node --import @swc-node/register/esm-register bench/bench-sync-docker.ts \
     --start-stack --stop-stack \
     --output /tmp/prosa-sync-bench.json
   ```

3. Clean up after:

   ```sh
   rm -rf /tmp/prosa-bench.sqlite /tmp/prosa-bench /tmp/prosa-bench-parquet
   ```

## Conventions

- Each script must be standalone (no shared imports across `bench/`).
- Hard-coded paths live at the top of each script; rewrite if your bundle
  lives elsewhere.
- Sync benchmarks must copy the bundle to a temporary work directory, set a
  temporary `PROSA_CONFIG_PATH`, and pass `--keep-local`; never run them against
  the live `~/.prosa` bundle directly.
- Numbers should be reproducible on the same hardware; record CPU and bundle
  size in any results doc that cites them.
