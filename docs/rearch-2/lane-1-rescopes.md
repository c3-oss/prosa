# Lane 1 — Proposed Re-Scopes (pending Codex acceptance)

The original Lane 1 contract in `02-lane-1-local-store.md` names two
concrete technology choices that the current implementation does not
ship verbatim: **RocksDB for the four shard backends** and **Parquet
for projection segments**. Both choices are intentionally substituted
with reviewed-equivalent alternatives in the current Lane 1 codebase.

**Status (2026-05-18): both re-scopes accepted by the project owner.**
This document is now the authoritative source for the two substitutions
in `docs/rearch-2/02-lane-1-local-store.md` (linked from that lane
doc's Goal section). Lane 1 acceptance flows through these re-scopes;
RocksDB-proper and Parquet emission remain open follow-up
optimisations, not Lane 1 blockers.

## Re-scope 1: `MemoryShardActor` (append-log) in place of RocksDB

### What changed

The lane doc says: "4 RocksDB shards backing the `ShardActor` interface."
The current implementation ships `MemoryShardActor` in
`packages/prosa-bundle-v2/src/shard/memory-actor.ts` which:

- Implements the full `ShardActor` contract: `PutIfAbsent`, `Reserve`
  (with TTL extension/expiry), `CommitReservation`, `Get`.
- Persists every command to a per-shard append-log file under
  `index/shard-NN.log`.
- Replays deterministically on `openPersistent(path)` so a
  process-crash recovers the exact prior state.
- Uses `writeFileDurable` (open + write + fsync + close) for every
  emitted log entry.

### Why this is proposed as production-equivalent for Lane 1

- **Same external semantics.** The `ShardActor` interface is the only
  surface consumers see. Swapping the backend later (RocksDB, sled,
  LMDB, …) is a transparent change as long as the interface is
  preserved.
- **Same crash-safety guarantee.** The append-log is durable (fsynced
  per write). A crash leaves either a fully-applied entry or no entry;
  there is no torn write. The same is true of a well-configured RocksDB
  WAL.
- **Same correctness profile against the canonical tests.** All Lane 1
  integrity corrections (`CQ-020..CQ-063`) and the new `CQ-065`
  stress gate exercise the actor through the interface. No correction
  in the chain references RocksDB internals.

### What this re-scope does **not** cover

- **Compaction / size profile.** Append-logs grow without compaction.
  Production-scale stores (many millions of writes) will eventually
  need either log compaction or the RocksDB swap. This is a
  performance issue, not a correctness one; Lane 1 does not commit to
  a compaction strategy.
- **Read latency at very large state.** All keys live in memory after
  `openPersistent`. Stores with state larger than a process's RAM
  budget will need the swap.

### Migration path (if Codex accepts and later swaps)

1. Add a `RocksdbShardActor` implementing the same interface in a
   follow-up commit.
2. Add a `Bundle.openWithShards(opts)` choice between backends.
3. Migrate existing append-logs by replaying them through the
   RocksDB actor's `PutIfAbsent` path; the on-disk RocksDB format
   then becomes the new ground truth.
4. Older append-logs are archived under `index-old-<timestamp>/`.

The bundle format itself (head.json, epoch manifests, packs,
projection segments) is backend-independent, so this migration is
local to the `index/` subtree.

## Re-scope 2: Canonical NDJSON in place of Parquet projection segments

### What changed

The lane doc Task 6 says: "Parquet projection segment writers per
entity type." The current implementation ships
`packages/prosa-bundle-v2/src/projection/segment-writer.ts` which
emits one canonical-NDJSON file per entity type with a
`.prosa-projection.ndjson` extension. The file format is:

- One small header line (canonical JSON): `bundleFormat`, `segmentKind`,
  `entityType`, `rowCount`.
- One canonical-JSON encoded row per data line, sorted by primary
  key ASC bytewise (per CANONICAL.md rule 7).
- File ends with a final newline. `BLAKE3` of the full file bytes is
  the segment digest.

### Why this is proposed as production-equivalent for Lane 1

- **Byte-equality with the Merkle-leaf pipeline.** The same
  canonical-JSON encoder used here (`canonicalJsonString` in
  `pack/framing.ts`) is what the Merkle-leaf pipeline already hashes.
  Parquet would introduce a different byte representation and would
  need a separate Merkle-leaf protocol.
- **Verifiable in one pass.** A rebuild can re-encode rows
  byte-for-byte and compare to the file content (see `sealEpoch`'s
  `verifyProjectionSegmentMatchesRows`). Parquet's binary format
  would require a Parquet decoder in every verifier.
- **Stream-friendly under integrity rules.** Cold rebuild reads each
  row, derives the shard via `shardOf`, and writes to the per-shard
  log. The NDJSON line-oriented format is a natural fit for this
  streaming.
- **Same on-disk size profile under zstd.** When segments are bundled
  as zstd-compressed CAS packs for transport (a separate Lane), the
  NDJSON-to-zstd ratio is comparable to Parquet for the prosa row
  shape (mostly UTF-8 strings + small integers).

### What this re-scope does **not** cover

- **Parquet's columnar query speed at very large scale.** A bundle
  with hundreds of millions of rows will read more bytes from disk
  with NDJSON than with column-pruned Parquet. Lane 1 does not
  commit to a query latency budget.
- **External tools.** Tools that expect Parquet (DuckDB, Spark, etc.)
  cannot read these segments directly. A future iteration can add a
  one-way NDJSON→Parquet converter for analytics workloads.

### Migration path (if Codex accepts and later swaps)

1. Add a `parquet-segment-writer.ts` next to the NDJSON writer,
   producing files with a `.prosa-projection.parquet` extension.
2. Update the Merkle-leaf domain to include the file extension or
   format byte, so segments of different formats hash to different
   leaves.
3. The cold-rebuild logic dispatches on file extension.
4. Old NDJSON segments are kept for historical epochs; new epochs
   write Parquet.

## Acceptance record

**2026-05-18:** project owner accepted both re-scopes. The lane doc
`docs/rearch-2/02-lane-1-local-store.md` was amended in the same
commit to reference this document from its Goal section. Lane 1 is
now substantively complete; CQ-044's procedural Lane 1-acceptance
gate is satisfied by this acceptance.

RocksDB-proper and Parquet emission remain open follow-up
optimisations:

- A future iteration can add `RocksdbShardActor` next to
  `MemoryShardActor` without changing the `ShardActor` interface, and
  swap backends per-bundle.
- A future iteration can add `parquet-segment-writer.ts` next to the
  NDJSON writer, with the Merkle-leaf domain extended to include the
  file extension so different formats hash to different leaves.
