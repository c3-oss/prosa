# Tantivy Indexing Performance

> **Status: Implemented.** Multi-thread writer (`writer(300_000_000, 4)`)
> and incremental indexing landed together with migration v4
> (`search_index_status.last_indexed_rowid` + `schema_fingerprint`). See
> `packages/prosa-core/src/services/indexing.ts` and `packages/prosa-core/src/core/schema/sql/004_tantivy_checkpoint.ts`.

Empirical investigation of two changes to `rebuildTantivyIndex` in
`packages/prosa-core/src/services/indexing.ts`:

1. **Multi-thread writer + larger memory budget** — the current call
   `index.writer(50_000_000, 1)` is single-threaded with a 50 MB heap. Tantivy
   distributes the heap across threads internally and can run up to 8 indexing
   threads in parallel.
2. **Incremental indexing** — every successful `prosa compile` rebuilds the
   entire index from scratch (`rm -rf <bundle>/search/tantivy/` →
   `addDocument` for every row in `search_docs`), even when a typical run
   imports a handful of new files. Tantivy's segment-based architecture
   supports adding documents without a full rebuild.

## Setup

- **Hardware**: Apple M1 Pro, 8 physical cores, 16 GB RAM.
- **Bundle**: snapshot of `~/.prosa/prosa.sqlite` (≈2 GB) with **249 830**
  `search_docs` rows. 6 segments in the live Tantivy index, total ≈241 MB on
  disk.
- **Binding**: `@oxdev03/node-tantivy-binding@0.2.1`.
- **Method**: `bench/bench-tantivy.ts`. Each variant builds against a fresh
  on-disk index in `/tmp/prosa-bench/`, fed from the snapshot SQLite. The
  incremental section first builds a baseline index once with the recommended
  4-thread/300 MB config, then for each variant copies that baseline into a
  scratch dir and runs only the incremental upsert. The "incremental upsert"
  for each row is `deleteDocumentsByTerm('doc_id', row.doc_id)` followed by
  `addDocument(...)`, so the path also handles updates of previously-indexed
  rows.
- **Cutoff for the incremental subset**: rows with `rowid >= 237 960`, the
  bottom 5 % of `search_docs` by row id. That is **12 492 rows**, which is in
  the same order of magnitude as a typical compile that imports 16 source
  files (in this snapshot the import added ≈14 k docs across Codex + Claude).

## Results

### Full rebuild (all 249 830 rows)

| Variant | Heap budget | Threads | Wall time | Throughput |
|---|---:|---:|---:|---:|
| **baseline (current)** | 50 MB | 1 | **12.02 s** | 20 788 docs/s |
| memory only | 200 MB | 1 | 11.81 s | 21 158 docs/s |
| **multi-thread** | 300 MB | 4 | **6.28 s** | 39 795 docs/s |
| more threads | 600 MB | 8 | 6.24 s | 40 054 docs/s |

### Incremental upsert (12 492 rows on top of an existing index)

| Variant | Heap budget | Threads | Wall time | Throughput |
|---|---:|---:|---:|---:|
| baseline (current) | 50 MB | 1 | 0.76 s | 16 330 docs/s |
| **multi-thread** | 300 MB | 4 | **0.53 s** | 23 451 docs/s |
| more threads | 600 MB | 8 | 0.69 s | 18 158 docs/s |
| memory only | 200 MB | 1 | 0.79 s | 15 733 docs/s |

## Interpretation

### 1. Memory budget alone barely helps

The single-threaded run with `200 MB` is within noise of the run with `50 MB`
(11.81 s vs 12.02 s). Tantivy commits buffered docs to a new segment when the
heap fills, but with only one writer thread the bottleneck is the per-document
work (tokenization, inverted-index build). Bigger heaps mean fewer segments
written but each segment is also bigger, so total work is unchanged. The
takeaway: do not bump heap without bumping threads.

### 2. Threading is the dominant lever for full rebuild

Going from 1 to 4 threads drops wall time from 12.02 s to 6.28 s (≈1.91× the
single-threaded throughput). 8 threads is essentially the same as 4 (6.24 s);
this matches the hardware (8 physical cores, but we share the host with the
node main loop and other processes). Tantivy itself caps automatic thread
detection at 8.

The recommended config is therefore **`writer(300_000_000, 4)`**: 300 MB
total heap → 75 MB per thread, mirroring the per-thread memory of the current
single-thread baseline (50 MB) plus headroom for tokenization buffers.

### 3. Incremental is **a structural win, not a tuning win**

The incremental path takes **0.53 s** for the same workload that the full
rebuild does in **6.28 s** under the best multi-thread config — a **≈12× drop**.
Once we keep the index between compiles, every steady-state run pays only for
the new docs.

A direct comparison against today's pipeline:

| Scenario | Today (full rebuild, 1 thread) | Multi-thread full | Incremental |
|---|---:|---:|---:|
| Steady-state compile (≈12 k new docs of 250 k) | 12.0 s | 6.3 s | **0.5 s** |
| Big import (whole bundle) | 12.0 s | 6.3 s | n/a |
| First-ever build | 12.0 s | 6.3 s | n/a |

### 4. 8 threads on incremental is *slower*

For the small (12 k) batch the 8-thread run was 0.69 s vs 0.53 s with 4 threads.
The fixed cost of spinning up the writer pool dominates when there is little
work to do. Either keep `numThreads = 4` for both modes, or pick threads
adaptively (e.g. `min(8, ceil(rowsToIndex / 5_000))`).

## Implementation sketch

### A. Multi-thread writer (1-line change)

```ts
// packages/prosa-core/src/services/indexing.ts:167
- const writer = index.writer(50_000_000, 1);
+ const writer = index.writer(300_000_000, 4);
```

That alone halves the rebuild step under any compile that imports anything.

### B. Incremental indexing

The `@oxdev03/node-tantivy-binding` API supports the full incremental
contract — confirmed in `node_modules/.pnpm/@oxdev03+node-tantivy-binding@0.2.1/.../index.d.ts`:

- `Index.open(path)` — open an existing index.
- `IndexWriter.addDocument(doc)` — append a doc to a new segment.
- `IndexWriter.deleteDocumentsByTerm(fieldName, fieldValue)` — delete by exact
  match on a stored term-field. Required because the field's tokenizer
  (`raw` for `doc_id`) maps the stored value 1-to-1 to a single term.
- `IndexWriter.commit()` — publish buffered ops.
- Tantivy's merge policy compacts old + new segments in the background.

State to track per bundle:

- `last_indexed_rowid: number` — the maximum `search_docs.rowid` covered by
  the current index. Stored either as a new column on `search_index_status`
  (cleanest) or in the existing `prosa-index.json` sidecar
  (`bundle.paths.tantivy/prosa-index.json`).

Decision: add a column. The sidecar JSON is ad-hoc and easy to lose; the
table is durable and already versioned by migrations.

```sql
-- New migration v4
ALTER TABLE search_index_status ADD COLUMN last_indexed_rowid INTEGER;
```

The new flow inside `rebuildTantivyIndex`:

```ts
const last = getSearchIndexStatus(bundle, 'tantivy')?.last_indexed_rowid ?? 0;
const wantFullRebuild = !last || !indexExists(bundle.paths.tantivy);

const index = wantFullRebuild
  ? (await rmAndMkdir(bundle.paths.tantivy), new tantivy.Index(buildSchema(), bundle.paths.tantivy, false))
  : tantivy.Index.open(bundle.paths.tantivy);

const writer = index.writer(300_000_000, 4);

const select = wantFullRebuild
  ? `SELECT … FROM search_docs ORDER BY rowid`
  : `SELECT … FROM search_docs WHERE rowid > ${last} ORDER BY rowid`;

let maxRowid = last;
for (const row of bundle.db.prepare(select).iterate() as Iterable<SearchDocRow>) {
  if (!wantFullRebuild) {
    writer.deleteDocumentsByTerm('doc_id', row.doc_id);
  }
  writer.addDocument(makeDoc(row));
  maxRowid = row.rowid;
}
writer.commit();
index.reload();

updateSearchIndexStatus(bundle, 'tantivy', {
  status: 'ready',
  sourceDocCount: countSearchDocs(bundle),
  indexedDocCount: …,
  lastIndexedRowid: maxRowid,
  errorMessage: null,
});
```

#### Edge cases worth handling explicitly

1. **Schema change** — if the schema definition ever changes, the on-disk
   index is incompatible. Add a `schema_fingerprint` column (hash of the
   field list + types) and force a full rebuild when it differs from the
   build-time fingerprint. The migration that introduces this should
   compute the current fingerprint and write `last_indexed_rowid = 0` (i.e.
   "force rebuild on next compile") so existing bundles don't skip the
   first incremental run with a stale index.
2. **`search_docs` row updates without rowid change** — the projection
   currently writes a search_doc once per `(message_id, field_kind)`
   tuple via `INSERT OR IGNORE`-equivalent logic. If a future projection
   changes a stored field on an existing rowid, the incremental path
   misses the update. The `deleteDocumentsByTerm('doc_id', …)` step
   handles re-imports of the same doc when its rowid is **re-emitted**;
   to also catch in-place row updates we'd need to track an updated_at
   timestamp on search_docs and select rows touched after `last_indexed_at`.
   For the current importer behaviour (write-once), `rowid >` is enough.
3. **Forced full rebuild knob** — add `prosa index tantivy --full` as the
   recovery path. The CLI already exposes `prosa index tantivy`; the new
   flag passes a `forceFullRebuild: true` option through to
   `rebuildTantivyIndex`.
4. **Failure mid-incremental** — if the writer panics after some
   `addDocument` calls but before `commit()`, the on-disk segments are
   not published; opening the index again sees the previous state.
   `last_indexed_rowid` should only be advanced **after** `commit()`
   returns — i.e. update the status row in the same commit, or after.
5. **Segment fragmentation** — many tiny incremental commits will produce
   many small segments. Tantivy merges in the background, but a manual
   merge call after, say, every 50 incremental runs (or when segment
   count exceeds N) keeps query latency predictable. The binding does
   not currently expose a public `mergeSegments` method; if needed, fall
   back to a periodic full rebuild.

## Recommendation

Land **multi-thread writer first** — it is one line, no migration, and
halves the current rebuild step. Then implement **incremental indexing**
as a follow-up that pulls the steady-state cost down to under a second.

Both changes are independent: A) lifts the floor for large rebuilds and the
first-ever build; B) eliminates the rebuild step for every-day work.

| Change | Effort | Impact (steady state) | Impact (full rebuild) |
|---|---|---:|---:|
| Multi-thread writer | trivial | 12 s → 6 s | 12 s → 6 s |
| Incremental + multi-thread | medium | 12 s → 0.5 s | 12 s → 6 s |

## References

- Bench script: [`bench/bench-tantivy.ts`](../../bench/bench-tantivy.ts)
- Tantivy IndexWriter docs: <https://docs.rs/tantivy/latest/tantivy/index/struct.IndexWriter.html>
- Tantivy ARCHITECTURE.md (segment model): <https://github.com/quickwit-oss/tantivy/blob/main/ARCHITECTURE.md>
- Of Tantivy's Indexing — Paul Masurel: <https://fulmicoton.com/posts/behold-tantivy-part2/>
- Binding type defs: `node_modules/.pnpm/@oxdev03+node-tantivy-binding@0.2.1/.../index.d.ts`
