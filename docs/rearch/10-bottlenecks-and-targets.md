# 10 — Bottlenecks, invariants, and targets

This document is the briefest of the eleven. It exists so a reader who has worked through §00–§09 can finish with a one-page reference for the redesign envelope: what is broken, what must hold, and what to aim for.

## Where time is actually spent today

The three pipelines have distinct bottlenecks. Listed in descending order of impact.

### compile / compile-all (target: faster local ingest)

1. **SQLite WAL writer lock (one writer ceiling)**. The `transactional()` block holds the lock ~150 ms per file. Worker-thread parallelism over the same store yielded only ~15 % because ~14 of 16 workers sit in `busy_timeout` queue. This is the single load-bearing constraint.
2. **WAL frame walking inside long write transactions**. Any outer transaction longer than one file makes every `INSERT OR IGNORE` and `INSERT OR REPLACE` walk the WAL frames to check uniqueness. Measured 2.7–5.6× regression with savepoint batches of 8–32 files.
3. **FTS5 trigger tokenization** — already mitigated. Triggers are dropped across the run and the index is rebuilt in bulk at the end. Per-row trigger work is no longer paid during the import loop.
4. **CAS file I/O during flush** — already concurrent at 16. Filesystem write throughput is now mostly bound by raw disk; further parallelism doesn't help because of the single writer mutex elsewhere.
5. **Tantivy and Parquet rebuilds at end-of-run** — Tantivy is incremental. Parquet is always full but lives after `closeBundle`, so it doesn't compete with the writer. Together they account for a smaller fraction of wall clock than the import loop.

### sync (target: faster local → server promotion)

1. **Per-batch object-store HEAD wave**. `planUpload` and `verifyPromotion` each HEAD every declared object (up to 16 concurrent on the server side). With ~281 batches × ~5,000 objects × two waves, plus S3 round-trip latency, this is the dominant cost when most objects already exist.
2. **Per-batch four-RTT cycle**. plan → uploads → commit → verify is four sequential client→server round-trips per batch. 281 × 4 = 1,124 sequential RTTs at minimum. Even at 50 ms RTT, the fixed cost is ~56 seconds; observed wall clock is much higher because each leg also has server work.
3. **Sequential phase loop across 10 projection types**. CAS objects, then source files, raw records, sessions, search docs, tool calls, tool results, messages, content blocks, events, artifacts — each in its own batch family, each fully serial within a phase. `--batch-concurrency 4` (default) parallelizes within a phase but not across phases.
4. **No verifyPromotion amortization**. Each batch produces its own receipt and overwrites `remote_authority`. There is no way to do a single "verify the whole sync" at the end across all batches.
5. **Idempotency replay** — already implemented. `commit-upload` and `verify-promotion` reserve and replay on retry.
6. **Network keep-alive** — already enabled. TLS handshake cost is amortized.

### query API (target: low-latency reads, especially after promotion)

1. **Transcript multi-pass joins**. Six SQL passes per page (session header, counts, messages, content blocks, tool calls, tool results) plus per-page row_number-derived ordinal. Heavy when transcripts are long.
2. **CAS body fetch on demand**. Content blocks > 8 KiB require a second round-trip to `artifacts.getText`, which itself does Postgres + S3.
3. **Search filter parity gap**. Remote `search_doc` lacks first-class `role`, `tool_name`, `canonical_tool_type`, and `errors_only` columns. Filtered queries fail closed or fall back to local.
4. **Analytics dual path**. Remote runs SQL against Postgres; local runs DuckDB over Parquet. Two implementations, same templates.

## Invariants — what must hold across the redesign

| Invariant | Why it's load-bearing |
|---|---|
| **Raw byte preservation** | Every byte of every imported source file must remain reconstructible. Importer bugs ship as re-projection, never as re-import. The `source_files.object_id` + `raw/sources/*.zst` pair is the contract today; the redesign may move the bytes elsewhere, but the recoverability must survive. |
| **Idempotent re-imports** | Running compile twice on unchanged input produces zero new rows, zero new objects, zero new CAS files, and skips derived rebuilds. This is what makes prosa safe to run on cron. The keys are `(source_tool, path, size, mtime, content_hash)` for files, `(source_file_id, ordinal, raw_object_id)` for records, BLAKE3 for objects, and a handful of natural keys for projection rows. |
| **Canonical event graph unification across providers** | Five very different agent histories (Codex, Claude, Cursor, Gemini, Hermes) project into one set of canonical entities: `sessions`, `turns`, `events`, `messages`, `content_blocks`, `tool_calls`, `tool_results`, `artifacts`, `edges`. This unification is the product's reason to exist. The redesign must preserve at least the entity grain and the cross-provider semantics (canonical tool types, role enum, edge taxonomy). |
| **Content-addressed deduplication** | Identical bytes from any source share one stored copy, keyed by a strong cryptographic hash. Today: BLAKE3. The redesign may switch hash families but must keep dedup by content. |
| **Signed promotion receipts** | A sync that completed must leave a server-signed receipt that names exactly what was promoted (`PromotionReceipt` shape). Reads that route to the server must be able to point at a verified receipt as the source of authority for that bundle. |

## Explicitly allowed to break

| Surface | Yes, you may break it |
|---|---|
| **Local store schema** | Drop SQLite, replace tables, change column types, change FK structure, change indexes, change the entire DDL set. |
| **CAS hash family, compression, fanout** | BLAKE3 → BLAKE3-256/multi-hash/SHA3 — pick whichever. zstd-3 → zstd-19 if it buys speed elsewhere. The `objects/blake3/aa/bb/` fanout may change. |
| **Bundle on-disk layout** | Replace `prosa.sqlite + objects/ + raw/` with whatever ships best. RocksDB, LMDB, sled, a Parquet log, a CAS-only store with a separate index, multiple SQLites, an embedded KV — all acceptable. |
| **Sync protocol** | The handshake → plan → upload → commit → verify → cleanup sequence may be replaced wholesale. Log shipping, CDC, CRDT replication, batched receipts, end-of-stream verification — pick the right one. tRPC may go. HTTP may go. PROTOCOL_VERSION may jump to whatever number signals "incompatible". |
| **Server database** | Postgres + projection mirror may be replaced. Splitting into a hot OLTP shape + a cold OLAP shape is acceptable. Replication, read replicas, partitioning, sharding by tenant — all acceptable. |
| **Object store contract** | The `head/putIfAbsent/get/delete` interface may grow or shrink. Server-side packing of small objects into shard blobs is explicitly OK (proposal #12 already reserves the tables). |
| **tRPC + auth + tenant model** | Better Auth may stay or go. Organizations as tenants may be kept; multi-tenancy may be re-implemented. tRPC may be replaced by gRPC, REST, JSON-RPC, GraphQL, or a custom protocol. |
| **Read API shape** | All current `reads.*` procedures may be redesigned. The session listing / transcript / search / analytics surfaces may change. The web app may be rewritten. |
| **MCP server shape** | The six MCP tools may be redesigned, consolidated, split, or replaced. The HTTP / stdio transports may stay or go. Remote MCP for promoted bundles is in scope. |
| **CLI surface** | `prosa sessions` / `prosa session show` / `prosa sync` / `prosa compile` may be reorganized as long as the user-facing capabilities survive. |
| **Public API consumed by `apps/web`** | The web data layer may be rewritten alongside the new server. There is no third-party SDK that needs to keep compiling. |

The redesign **must not** silently break the five invariants. The redesign **may** break everything else.

## Target metrics

These are the success criteria the project lead is willing to defend. They define the design envelope.

### Compile (single laptop, 1.4 GB input, ~3k sessions, ~800k raw records)

- **First-import (fresh bundle): < 60 s wall clock.** Today: 329 s. Stretch: < 30 s.
- **No-op re-run (unchanged input): < 5 s wall clock.** Today: ~30 s. The "nothing changed" path must be near-instantaneous.
- **Single-file re-import (one new session file in an otherwise unchanged tree): < 2 s.**
- **CPU and disk usage**: explicitly allowed to spike. Memory under 4 GiB on the laptop is reasonable; under 2 GiB is nice-to-have.

### Sync (laptop → cloud server, same workload)

- **Fresh promotion (no objects on server): bandwidth-bound.** Should saturate a 100 Mbps uplink to S3, ~1 GB → ~80 s. Today: ~2 hours.
- **No-op re-sync (everything already promoted): < 10 s.** Today: > 1 hour. The "nothing changed" path must be near-instantaneous.
- **Single-session delta sync (one new session): < 10 s.** Today: minutes (still pays the 281-batch shape).
- **Resumable interruption**: a sync killed at 50 % completes the remaining 50 % on resume, with no re-upload of already-promoted batches. (This works today via the checkpoint; redesign must preserve it.)

### Query API (single user, single tenant)

- **`sessions list` (50 rows, no filter), p95: < 100 ms** local; **< 200 ms** remote.
- **`sessions transcript` first page (typical session, < 200 messages): < 300 ms** local; **< 500 ms** remote.
- **`search query` (50 hits): < 100 ms** local; **< 200 ms** remote.
- **`analytics report` (fixed reports): < 1 s** local; **< 2 s** remote.
- **`artifacts.getText` (1 MiB body): < 1 s** end-to-end.

These targets are aggressive. Hitting them likely requires more than a parameter tune of the current architecture — that's the point.

## Workload shape (to size the design)

| Dimension | Typical heavy user (current observation) |
|---|---|
| Bundle size on disk | 1–5 GiB |
| Sessions per bundle | 1k–10k |
| Source files per bundle | 1k–5k |
| Raw records per bundle | 500k–5M |
| CAS objects per bundle | 500k–2M |
| Search docs per bundle | 100k–500k |
| Median session size (messages) | 20–80 |
| Long session size (messages) | 500–5,000 |
| Median CAS object size | ~1–4 KiB |
| Largest single CAS object | 10–100 MiB (artifact bytes, big tool outputs) |
| Importers active simultaneously on a laptop | 1 (single CLI process at a time) |
| Concurrent agents reading via MCP | 1–4 |
| Tenants per server | 1–thousands (multi-tenant target) |
| Bundles per tenant | 1–many machines, all sharing one tenant |

The bundle has the rough shape of a **content-addressed pack of small objects with a moderate-size relational index over them**. The dominant operations are:

- Bulk write at compile time (many small objects, many index rows).
- Append-mostly during incremental compile (new sessions appended; old ones rarely re-edited).
- Concurrent reads of small slices (sessions list, transcript pages, search).
- Occasional analytics scans (DuckDB queries spanning multiple tables).

A redesign that picks storage + protocol primitives that match this workload (e.g. log-structured stores, mergeable manifests, columnar projection, signed batched receipts) is in scope. A redesign that just retunes the current shape is not — that has been done.

## What the prompt in §11 asks for

Given §00–§10, the rearchitecture prompt in §11 asks the team to produce:

1. A high-level architecture diagram for the new system.
2. A detailed protocol design with wire formats for the sync path.
3. Storage choices with justification — local store, remote OLTP, remote OLAP, object store, search index.
4. A concurrency / pipelining model — where the writer lock goes, how compile and sync share a pipeline (or don't), how reads stay snappy under load.
5. Target performance envelope with the assumptions baked in.
6. A migration plan — explicitly one-shot cutover, no backward-compat shims.

The next section is that prompt.
