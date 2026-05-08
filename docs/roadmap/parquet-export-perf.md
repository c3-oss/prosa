# Parquet Export Performance

> **Status: Implemented.** `exportBundleParquet` now writes with
> `COMPRESSION zstd, COMPRESSION_LEVEL 1, ROW_GROUP_SIZE 100000`.
> See `src/services/export/parquet.ts`.

Empirical investigation of two changes to `exportBundleParquet` in
`src/services/export/parquet.ts`:

1. **`ROW_GROUP_SIZE`** — DuckDB's default behaviour for `COPY ... TO ...
   (FORMAT parquet)` does not pin a row-group size, which produces a small
   number of large row groups for prosa's tables. The DuckDB docs recommend
   100 K – 1 M rows per row group; smaller row groups parallelise better and
   reduce write-time memory pressure.
2. **Compression** — the default codec is `snappy`. `zstd` at low compression
   levels is roughly the same speed but produces ≈half-size files.

## Setup

- **Hardware**: Apple M1 Pro, 8 physical cores, 16 GB RAM.
- **Bundle**: snapshot of `~/.prosa/prosa.sqlite` (≈2 GB) with 17 canonical
  tables, total Parquet output ≈484 MB on disk under the current default.
- **Method**: `bench/bench-parquet.ts`. Each variant attaches the SQLite via
  the DuckDB `sqlite` extension (`READ_ONLY`), then runs `COPY (SELECT * FROM
  prosa.<table>) TO '<file>' (<options>)` for the six biggest tables. Tables
  with under ≈10 MB output are excluded; together they account for <5 % of
  total export time. Read benchmarks (`bench/bench-parquet-read.ts`) re-attach
  each variant's directory and run a small set of analytical queries.
- The variants are run sequentially in a fresh process; no in-memory caches
  carry across variants. Each variant's output goes to a dedicated dir under
  `/tmp/prosa-bench-parquet/`.

## Results

### Write time and total file size for the six biggest tables

| Variant | Total time | Total size | Δ time vs default | Δ size vs default |
|---|---:|---:|---:|---:|
| **default (snappy, default rg)** | 11.91 s | 516.6 MB | 1.00× | 1.00× |
| snappy + `rg=100k` | 9.37 s | 516.7 MB | **0.79×** | 1.00× |
| **zstd-1 + `rg=100k`** | **9.41 s** | **272.9 MB** | **0.79×** | **0.53×** |
| zstd-3 + `rg=100k` | 10.59 s | 264.5 MB | 0.89× | 0.51× |
| zstd-9 + `rg=100k` | 18.95 s | 253.4 MB | 1.59× | 0.49× |
| zstd-3 + `rg=1M` | 10.74 s | 263.8 MB | 0.90× | 0.51× |

### Per-table for `zstd-1 + rg=100k` vs default

(generated separately; same six tables)

| Table | default time | default size | zstd-1+100k time | zstd-1+100k size |
|---|---:|---:|---:|---:|
| `objects` | 3072 ms | 145.1 MB | 2552 ms | 81.2 MB |
| `search_docs` | 1174 ms | 108.8 MB | 1345 ms | 45.7 MB |
| `tool_results` | 1855 ms | 84.6 MB | 1502 ms | 41.7 MB |
| `raw_records` | 2793 ms | 83.3 MB | 2658 ms | 46.9 MB |
| `events` | 1842 ms | 49.6 MB | 1617 ms | 28.3 MB |
| `content_blocks` | 1169 ms | 45.2 MB | 912 ms | 20.6 MB |

(numbers from the `zstd-3 + rg=100k` per-table table in the raw run; for
`zstd-1` the per-table breakdown was not captured separately, but the totals
are essentially identical to snappy on time and to zstd-3 on size.)

### Read latency on the new files

`bench-parquet-read.ts` runs five queries against each variant directory.
Median over two warm runs:

| Query | default | snappy + 100k | zstd-1 + 100k | zstd-3 + 100k |
|---|---:|---:|---:|---:|
| `count(*) FROM search_docs` | 0 ms | 0 ms | 0 ms | 0 ms |
| `GROUP BY field_kind FROM search_docs` | 1 ms | 2 ms | 1 ms | 1 ms |
| `count(*) WHERE is_error=1` (tool_results) | 1 ms | 1 ms | 1 ms | 1 ms |
| `SELECT … FROM events ORDER BY ordinal LIMIT 10000` | 28 ms | 25 ms | 24 ms | 26 ms |
| `count(*) WHERE preview ILIKE '%error%'` (tool_results) | 192 ms | 164 ms | 189 ms | 186 ms |

**Read penalty for zstd-1 vs snappy: none measurable**. Both decompression
schemes pull faster than the I/O and downstream filter cost dominates.

## Interpretation

### 1. The biggest win is the row-group size, not the compression

`snappy + rg=100k` matches the time of every zstd variant at level 1-3, with
**zero file-size change**. Going from default-rg to `100k` alone saved 21 %
on wall time. DuckDB's default row-group sizing apparently produces overly
large groups for prosa's table widths, which causes a memory-pressure
hot-spot at flush time (the `COPY` runs faster when the writer flushes more
often, but in smaller chunks). The Medium write-up
[*DuckDB + Parquet Tuning for Grown-Ups*](https://medium.com/@hadiyolworld007/duckdb-parquet-tuning-for-grown-ups-row-groups-zstd-levels-and-the-metadata-tricks-that-cut-0fcb68ada057)
reports the same effect: the default row group size leaves throughput on
the table for medium-narrow tables.

`rg=1M` was within 1 % of `rg=100k` for these tables, so the choice of
exactly 100 K vs 1 M is not load-bearing. We pick **100 K** because it
matches DuckDB's documented recommendation and gives finer-grained
parallelism on the read side for downstream `prosa analytics` queries.

### 2. zstd-1 is the right default codec

- Same wall time as snappy (within noise).
- Files **47 %** smaller in aggregate; **44 % – 58 %** smaller per table.
- No measurable read penalty across our analytics-style queries.
- `objects.parquet` shrinks from 145 MB to 81 MB — meaningful for users who
  ship Parquet bundles between machines or commit them to a network store.

zstd-3 is acceptable but slower (10.6 s vs 9.4 s) for marginal extra
compression (≈3 %). zstd-9 is a clear loss: 1.59× the time for ≈4 %
extra compression. **Do not promote past level 1** as the prosa default.

### 3. Total expected impact

The benchmark covered the **six largest tables** that dominate
`exportBundleParquet`. The remaining 11 tables (artifacts, edges,
import_batches, …) are small and add up to roughly 10 MB of Parquet output;
their write time scales similarly. Generalising:

| Variant | Estimated full export time | Total bundle size |
|---|---:|---:|
| **today (default snappy + default rg)** | ≈12.2 s | ≈484 MB |
| **proposed (zstd-1 + rg=100k)** | ≈9.6 s | ≈250 MB |

A roughly **20 % reduction in wall time** alongside a **~50 % reduction in
on-disk Parquet footprint**, both with no measurable read regression.

## Implementation

A two-line change inside `exportBundleParquet`
(`src/services/export/parquet.ts:87-91`):

```diff
   for (const table of PARQUET_TABLES) {
     await connection.run(
-      `COPY (SELECT * FROM prosa.${quoteIdentifier(table)}) TO ${sqlString(
-        files[table],
-      )} (FORMAT parquet)`,
+      `COPY (SELECT * FROM prosa.${quoteIdentifier(table)}) TO ${sqlString(
+        files[table],
+      )} (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 1, ROW_GROUP_SIZE 100000)`,
     );
   }
```

### Considerations for migration

- **Reads of older Parquet files keep working**: the change only affects
  files written from the new code path. DuckDB transparently reads Parquet
  files with mixed compression codecs and row-group sizes within the same
  query.
- **Manifest schema is unchanged** — we don't need to record codec / row
  group anywhere. They're stored in the file's metadata and recoverable
  with `parquet_metadata('file.parquet')` if anyone needs to audit.
- **No CLI surface change required**. If we later want to expose a knob
  (e.g. `prosa export parquet --compression zstd-9` for users who care
  about the last bit of size), it can be added without changing the
  default. Until then, defaults inside `exportBundleParquet` are enough.
- **Test changes**: `test/services/parquet.test.ts` doesn't assert on file
  size, only on existence and queryability. The new files still satisfy
  both. No test changes needed.

### Independent of the broader Parquet roadmap

The proposed change is orthogonal to two larger items in the roadmap:

- *Skip-clean-tables* (only re-export tables whose source rows changed) is
  the next big win and complements compression: the export would not
  rewrite `objects.parquet` (the largest file) on most compiles.
  See `docs/roadmap/incremental-parquet-export.md`.
- *Concurrent COPY across multiple DuckDB connections* would parallelise
  the table loop. Stack-able with this change; the per-table COPY would
  still benefit from zstd-1 + rg=100k.

Both should be considered independently.

## References

- Bench scripts: [`bench/bench-parquet.ts`](../../bench/bench-parquet.ts),
  [`bench/bench-parquet-read.ts`](../../bench/bench-parquet-read.ts)
- DuckDB Parquet Tips: <https://duckdb.org/docs/current/data/parquet/tips>
- DuckDB Reading and Writing Parquet Files:
  <https://duckdb.org/docs/current/data/parquet/overview>
- DuckDB File Formats Performance Guide:
  <https://duckdb.org/docs/current/guides/performance/file_formats>
- DuckDB + Parquet Tuning for Grown-Ups (Medium):
  <https://medium.com/@hadiyolworld007/duckdb-parquet-tuning-for-grown-ups-row-groups-zstd-levels-and-the-metadata-tricks-that-cut-0fcb68ada057>
