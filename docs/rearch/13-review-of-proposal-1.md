# 13 — Review of proposal 1

A four-specialist review of the proposal, conducted against the handoff package (`00-README.md` through `11-rearchitect-prompt.md`) and the current source code. Each subsystem (local store, importers, sync protocol + server, reads/MCP/CLI) was reviewed independently. This document consolidates findings; line numbers reference the proposal unless stated otherwise.

## Verdict

**Architecturally sound; ship-blocking gaps in the write path; needs one more design pass before any DDL or wire format is cut.** The proposal correctly identifies the load-bearing constraint (the SQLite WAL writer lock plus the 281-batch HEAD wave) and chooses the right structural answers (segment-log + content-addressed packs + receipt-pinned reads + bundle-root Merkle). It is feasible to build, fits the workload shape, and the migration story respects the five invariants. However, four concrete behaviors in the current system have no specified home in the new model, and they will silently break correctness if implementation starts from this document as-is.

## What we endorse without reservation

- **Bundle-as-segment-log with epoch atomic commit (`head.json` swap).** The right model for an append-mostly workload. Removes the WAL writer lock from the import critical path. Makes reads cheap and snapshot-consistent. Enables migration as a one-shot re-projection from raw bytes (§2.1, §6).
- **Content-addressed pack blobs for small CAS objects (§3, lines 577–608).** Directly attacks the per-object HEAD wave that dominates the empirical 2-hour sync. The 32–128 MiB pack size matches S3 round-trip economics. Standalone-large-object threshold is correct.
- **Receipt-pinned remote reads with bundle-root Merkle (§2.5).** Cleaner than the current per-batch receipt model. Makes "what exactly was promoted?" cryptographically falsifiable. The six sub-roots (rawSource, objectSet, projection, search, analytics, sessionBlob) are the right decomposition.
- **Background S3 audit replacing per-batch byte verification (line 410).** The single largest structural win available. The current `verifyPromotion` HEADs every declared object on every batch; v2 moves verification to ingest time + periodic audit. Frees the protocol from the 4-RTT-per-batch ceiling.
- **One search schema, Tantivy local and remote (§3, lines 619–644).** Closes the today's filter parity gap (no `role`/`tool_name`/`canonical_tool_type`/`errors_only` on remote). Correct unification.
- **Postgres for control plane / hot cache + ClickHouse for OLAP (§3, lines 514–574).** The right split. Postgres for authority transactions; ClickHouse MergeTree for the scan-heavy projection. The proposed partition strategy is appropriate at small/medium tenant counts.
- **Compile and sync sharing a segment stream without compile depending on remote success (lines 727–733).** Hides upload latency behind local indexing without coupling local correctness to the network.
- **Migration as one-shot rebuild from preserved raw bytes (§6).** Exactly what the raw-preservation invariant exists for. Re-projection beats compat shims.

## Load-bearing gaps that must close before cutting DDL or wire format

These are the items where the proposal is either silent or hand-waves. Each one represents a correctness or feasibility risk significant enough to redesign around. They are listed in priority order.

### G1. Late-bound projection columns and Parquet immutability

Codex's `linkSubagentParents` runs a global `UPDATE sessions SET parent_session_id = ...` after every file in the batch commits, because the parent session may live in a different file. Parquet row groups, once written, do not support updates. The proposal does not mention this UPDATE, the `parent_session_id` column, or any deferred-resolution layer. Three possible answers — append a fix-up segment, re-emit the sessions Parquet for the epoch, or resolve at read time via the `edges` segment — each have different cost profiles and the proposer must pick one explicitly. Without it, all subagent sessions are silently emitted with `parent_session_id = NULL` in Parquet and ClickHouse.

### G2. Shard key for 16 RocksDB shards and atomic uniqueness

Lines 478–491 define key prefixes (`source:`, `record:`, `object:`, `entity:`) per shard but never state the shard key function. The current SQLite UNIQUE constraints rely on the entire DB being a single serializable writer. With 16 independent RocksDB DBs, two concurrent import workers can each check "does `source:<tool>:<path>` exist?" against shard K before either writes and both can proceed. Without a deterministic shard assignment plus a per-shard write lock per key type — and a coordinator for cross-shard idempotency — the dedup guarantee is lost on the first parallel compile. The proposal must specify the shard function, the per-shard contention model, and whether uniqueness keys are confined to one shard or coordinated across shards.

### G3. Hermes dual-source session merging — `ImportFrame` is not 1:1 with logical sessions

The Hermes importer reads both `~/.hermes/state.db` and `~/.hermes/sessions/*.jsonl` and merges per-session candidates by message count. Two physical source files contribute to one logical `source_session_id`. The proposed `ImportFrame` model emits one frame per source file. If the SQLite scan and the JSONL scan both produce a frame for session X, the graph segment writer receives two `SessionV2` rows with the same natural key and must merge or supersede. The proposal does not describe this merge layer. Either `ImportFrame` is not 1:1 with source files (the importer batches multiple files into one frame for a session) or the graph writer is an upsert with a precedence rule. Pick one.

### G4. Pack writer contention — risk of moving the WAL writer lock

§3 (line 498) says writer locks live in "one append lock per CAS pack writer" and "one Parquet writer per entity type per epoch." §4 (line 504) says importer workers emit `ImportFrame`s into queues consumed by pack/index writers. If the design is fan-in (N importers → 1 pack writer) the pack writer mutex is the new ceiling, with the same single-threaded-append shape as today's SQLite. If the design is sharded pack writers (one per import worker, merged at epoch seal) the contention disappears but the segment layout becomes more complex. The proposal does not specify which shape is intended. Without that decision the central performance claim (escape from the WAL writer lock) is unverifiable.

### G5. Streaming validation memory footprint on the server

§2.3 (lines 301–309) describes validating each pack entry while streaming: decompress + BLAKE3 + canonical hash equality + offset bounds, then S3 multipart write. For a 128 MiB pack with a 10× compression ratio worst case, a worker that buffers decompressed bytes before confirming `storedHash` holds 1.28 GiB in flight. At 32 concurrent uploads that is 40 GiB of working set per API worker. The proposal sets `maxObjectPackBytes` (line 577) without a corresponding per-worker RAM budget. The implementation must either stream decompressed bytes directly into the S3 multipart upload (no in-process accumulation) and cap parallelism at the OS pipe limit, or accept much smaller pack sizes. State explicitly.

### G6. Multi-machine same-tenant union view

`previousReceiptId` chains and `remote_authority_v2` are per `(tenant_id, store_id)`. Laptop A and Laptop B push to the same tenant under different `storeId`s. The web's "all sessions for this tenant" requires a union across stores. The ClickHouse table at line 543 is `PARTITION BY (tenant_id, store_id) ORDER BY (tenant_id, store_id, ...)` — a tenant-scope-only query does a full partition scan. No global-union view, no cross-store secondary index, no procedure for "current authoritative receipt per `(tenant, session_id)`" is defined. This is a hole in the read API that the current design doesn't have (because today's reads scope to one store).

### G7. Ed25519 device key history and rotation

§2.2 (line 173) requires the device public key in `BeginPromotion`. §2.5 (line 376) bakes `devicePublicKey` into the receipt payload. If a laptop dies and the user buys a new one, they register a new device key — but old receipts still embed the old key, and audit of the chain requires that key to remain queryable. The current `device` table has no key-history column. The proposal needs either a `device_public_key_archive` table, an explicit "device keys are append-only on register" rule, or a cross-signing ceremony at handshake time. Without it, valid old receipts become unverifiable as soon as a user replaces a laptop.

### G8. `MissingObjectPlan` canonical ordering

§2.2 (lines 232–237) describes `range_list` and `roaring_bitmap_zstd` encodings over "manifest order." The server does not store any client-specific manifest. Without a deterministic shared ordering (BLAKE3-hex ascending over `objectSetRoot` is the natural choice), the encoding is undefined. Both sides must implement the same sort; the bitmap is meaningless otherwise.

### G9. `tenant_object` row-per-object grant at scale

§3 (line 602) carries forward the v1 access-grant model: one row per `(tenant_id, object_id)`. With 800k objects × thousands of tenants this reaches billions of rows. The natural v2 unit is the pack (one row per `(tenant_id, pack_digest)`), reducing the grant table by 3–4 orders of magnitude. The proposer should explicitly choose: are pack blobs the access unit, or do tenants still grant per object? This decision affects S3 layout, deletion semantics, and the read path.

### G10. Receipt refresh policy on the CLI

The CLI caches the latest receipt in `~/.config/prosa/config.json`. The proposal says reads serve from local cache when its root matches the receipt root, else go remote (line 783). It does not say *when* the CLI refreshes the cached receipt. On every read? On HTTP 412 from the server? Per TTL? Polling? Without a refresh trigger, a user with two laptops who promotes from laptop B will keep serving stale local reads on laptop A indefinitely. State the refresh contract.

### G11. Transcript blob (`session_blob_pack`) schema

§3 mentions `sessionBlobRoot` but never defines what is *inside* a blob. The current transcript paginates over messages with cursor pagination and defers bodies > 8 KiB to a separate round-trip (`INLINE_TEXT_BUDGET_BYTES`). The blob is the heaviest read path; leaving its schema undefined is the largest source of operational risk in the read story. The proposal must specify: max blob size; the inline/CAS-pointer split policy; the multi-page strategy for sessions with 5,000+ turns; whether the blob carries denormalized tool_calls inline or only pointers.

### G12. Cold no-op compile target after RocksDB loss

§3 (line 511) says "if RocksDB or Tantivy is missing/corrupt, rebuild from epoch manifests and Parquet/Arrow segments." The no-op compile target is 0.5–2.5 s (line 800). Rebuilding the source-state index from Parquet, plus parallel stat over 3,173 files, exceeds the lower bound. The proposal does not distinguish warm-cache from cold-rebuild no-op. State both targets explicitly and confirm acceptance.

## Subsystem review

### Local store and CAS

Beyond G1, G2, G4, G12: the `raw_source_pack` segment format (line 101) needs an embedded per-entry offset index analogous to `ObjectPackHeaderV2.entries[].storedOffset`. Without it, "give me back original Codex JSONL file X" degrades from O(1) to O(pack-size). The `SourceState` value in RocksDB must carry `(pack_digest, byte_offset, byte_length)` to preserve random-access raw byte recovery.

The re-projection invariant ("raw bytes are source of truth; projection is rebuildable") is implicit in the migration section but absent from §3. Future contributors may treat sealed epoch projection segments as authoritative and stop retaining raw_source packs. Add an explicit rule in §3: "raw_source_pack segments must be retained as long as their epoch manifest exists."

### Importer pipeline

Beyond G1, G3: `SessionV2` is referenced at line 679 inside `ImportFrame` but never given a concrete field list. `MessageV2` likewise. Cursor's `timeline_confidence='low'` column is invisible in the proposal; if `SessionV2` simply inherits today's column set the property holds, but the omission is worth flagging because Cursor's honest quality signal is one of the few cases where the canonical schema accepts uncertainty.

Partial-file parse failures need explicit GC. Today, orphan CAS files on disk are safe because BLAKE3 dedupes them. In v2, partially-flushed pack writes that were not referenced by a sealed epoch must be GC'd; if compile-and-sync shared pipeline already shipped a half-written pack to S3 staging, the cleanup story extends to the server. Specify both halves.

### Sync protocol and server

Beyond G5, G6, G7, G8: the multipart S3 path needs to specify checksum mode. AWS S3 supports `Content-MD5` per part plus full-object checksums; for BLAKE3 the server computes locally and validates against the declared `transportHash` rather than relying on S3-side checksums. The proposal mentions S3 multipart but does not state where the BLAKE3 verification line sits. Spell it out.

The `materializing` status (line 339) means readers see partial state during seal. Readers continue to see the previous receipt — this is correct — but the proposal should explicitly forbid any reader from honoring an unfinished receipt. Add to §2.4.

Background audit (line 410, G in §10) needs an owner, a cadence, and a drift response. Without those, `noPerObjectHeadRequired: true` is a claim with no enforcement. Specify: cron interval, drift action (re-promote vs invalidate vs alert-only), and which tier (API workers, separate job, third-party storage scanner) executes it.

### Reads, MCP, CLI

Beyond G10, G11: `--authority auto` for MCP (line 780) is the wrong default if interpreted per-query — agents that call `search` then `sessions` would get inconsistent snapshots within one conversation turn. Pin "auto" to a single `ReadContext` at MCP server startup; refresh only on explicit signal (HTTP 412, user-driven `prosa sync status --refresh`, or process restart).

The remote Tantivy "atomically switch alias" claim (line 639) is operational hand-waving. Tantivy has no alias primitive. The implementation needs either (a) embedded Tantivy in each API worker with per-worker generation tracking and stale-cache fallback, or (b) a separate stateful Tantivy fleet with a Postgres-backed pointer and reload signals. Both are real architectures with concrete failure modes. Pick one.

Local DuckDB over incremental Parquet needs a compaction policy. After 100 small no-op-or-delta epochs, `head.json` references 100 Parquet files per entity type. DuckDB scans all of them per query; file-handle fanout degrades analytics linearly with epoch count. Specify a compaction trigger (epoch count threshold, total small-file byte count, or post-sync cleanup pass).

The unified `prosa read sessions / transcript / search / analytics` surface (line 776) needs an explicit mapping from current commands. `prosa session show --format markdown`, `prosa export parquet`, `prosa query duckdb '<sql>'`, `prosa analytics report --columns ...` each carry today affordances that scripts depend on. Map the old surface to the new surface 1:1 in §4 before deprecation.

## Consolidated questions for the proposer

These are the smallest set of questions that, when answered, unblock implementation. Each maps to a gap above.

1. **(G1)** How does `parent_session_id` (and other post-commit UPDATE columns) reach the sealed Parquet / ClickHouse projection? Append a fix-up segment, re-emit the sessions Parquet for the epoch, or resolve at read time from the `edges` segment?
2. **(G2)** What is the shard key function for the 16 RocksDB shards, and how is atomic uniqueness enforced for natural keys whose owning shard differs from their FK shard? Per-shard CAS, single coordinator, or per-entity-type single-shard assignment?
3. **(G3)** When two `ImportFrame`s carry the same `source_session_id` from different physical files (the Hermes case), which layer selects the winner — the importer worker before emit, the queue consumer, or a graph-segment-writer upsert with precedence?
4. **(G4)** Are pack writers one-per-importer-worker or one-global? If one-global, what is the expected pack writer throughput vs the current SQLite WAL writer rate of ~one 150 ms commit per file?
5. **(G5)** Does pack validation stream decompressed bytes directly into the S3 multipart upload or accumulate them in worker memory? State the worst-case in-process buffer for a 128 MiB pack and the per-worker `maxConcurrentUploads`.
6. **(G6)** How does the Read API answer "all sessions for this tenant across all stores"? Global-union view in ClickHouse, hot-cache table in Postgres keyed only by `(tenant_id, session_id)`, or store enumeration required of the caller?
7. **(G7)** Are device public keys retained in full history per `device_id` so old receipts remain verifiable after rotation? Where is the archive?
8. **(G8)** What is the canonical ordering for `MissingObjectPlan` bitmap encoding — BLAKE3-hex ascending over `objectSetRoot`, or positional order from a declared manifest? Specify and pin.
9. **(G9)** Is the `tenant_object` row-per-object grant model intentional in v2, or open to replacement with `tenant_pack` grants at pack granularity? State the access unit.
10. **(G10)** What is the CLI receipt refresh trigger — startup check, HTTP 412 detection, TTL, or polling? What does the user see when staleness is detected mid-session?
11. **(G11)** Concrete `session_blob_pack` schema: max blob size; inline-vs-CAS-pointer rule; multi-page strategy for very large transcripts; what is denormalized vs referenced.
12. **(G12)** Cold no-op compile target after RocksDB loss: state explicitly and confirm acceptance, since the rebuild path exceeds 5 s on the reference workload.
13. **Background audit** owner, cadence, and drift response.
14. **`--authority auto`** for MCP: pinned at server startup or re-evaluated per query?
15. **Remote Tantivy** topology: embedded per worker or separate fleet, and the generation-swap mechanism that replaces the hand-waved "alias."
16. **Incremental Parquet compaction policy**: trigger and cadence.
17. **CLI surface mapping** from current `sessions list / session show --format markdown / search / query duckdb / analytics report / export parquet` to the unified `prosa read *` form.

## Feasibility and operational considerations

The proposal is feasible. Three operational realities the project lead should hold in mind:

- **ClickHouse operations at scale.** ClickHouse is the right choice for the projection workload but is operationally heavier than Postgres alone. Backups, replication, schema migrations, partition management, and merge tuning each carry runbook overhead. For low-tenant-count deployments this is acceptable. For thousands of tenants the partition-explosion concern the proposal acknowledges (line 566) is real; sharding the partition key by hash bucket is the right mitigation but adds a tier of indirection in the read API.
- **Server-side streaming validation CPU.** Every pack ingestion runs BLAKE3 + zstd decompression at line rate. A 32 MiB pack with 1024 entries costs roughly 100–200 ms of API-worker CPU end-to-end. At 100 concurrent uploads this saturates 10–20 cores per worker fleet member. Capacity planning belongs in the operational section of the new design.
- **Device-key infrastructure.** Ed25519 device keys, signed receipts, key rotation, key archival, audit verifiability — none of these are individually hard, but together they constitute a new cryptographic operations surface that does not exist today. The team should decide whether device-signed promotions are a v2.0 hard requirement or a v2.1 follow-on. The protocol can absorb the addition cleanly if `clientSignature` is optional at v2.0 and required at v2.1.

## Recommendation

**Accept the architectural skeleton; require a v2.0.1 design pass that closes G1–G12 before any DDL or wire format is cut.** The skeleton is right: segment log, content-addressed packs, receipt-pinned reads, background audit, ClickHouse for projection, Tantivy unified. The gaps are not skeleton gaps; they are completion gaps. A focused two- to four-week design pass on the seventeen questions in this review produces an implementable spec.

Concretely, the proposer should be asked for:

1. A revised proposal (or a companion design-closeout document) that answers each numbered question.
2. The concrete schema for `SessionV2`, `MessageV2`, `EventV2`, `ContentBlockV2`, `ToolCallV2`, `ToolResultV2`, `ArtifactV2`, `EdgeV2` — every column carried in `ImportFrame.projection`, with explicit nullability for late-bound fields.
3. The byte-level format for `raw_source_pack` (including offset index for random access).
4. The streaming validation worker memory budget and the corresponding `maxConcurrentUploads`.
5. A decision on `tenant_object` vs `tenant_pack` as the access-grant unit.
6. A decision on multi-machine same-tenant convergence (per-store receipts + read-time union view, or a converged per-tenant authoritative receipt).
7. The compaction trigger for incremental Parquet.

With those in hand, implementation can begin against a spec that has no load-bearing ambiguity.
