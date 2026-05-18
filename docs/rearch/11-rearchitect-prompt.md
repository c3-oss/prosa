# 11 — Rearchitect prompt

> This document is the actual prompt sent to the redesign team. It assumes the reader has read documents 00–10 in this directory. It is intentionally short — the heavy reference material is upstream.

---

## Brief

You are reading a snapshot of **prosa at v0.8.1 (May 2026)**. The repository is not available to you; everything you need is in documents 00–10 of this handoff package.

Prosa is a local-first ingest, indexing, and search system for AI-agent conversation histories. It imports session logs from five agent CLIs (Codex, Claude Code, Cursor, Gemini, Hermes) into a local SQLite + CAS bundle, optionally promotes that bundle to a multi-tenant cloud server (Postgres + S3), and serves reads to a CLI, an MCP server, a web console, and a remote read API.

The team has spent two months on incremental performance work — roughly twenty-five merged perf-focused PRs (#37–#47 plus targeted commits), measured wins on SQLite PRAGMA tuning (-37 % compile-all), WASM BLAKE3 hashing, S3 keep-alive, batched lookups, manifest caches, producer-consumer pipelines, adaptive upload concurrency, and set-based object packs. Despite all this, a real-world local-to-remote sync of a 1.4 GB bundle still takes roughly **two hours wall clock**.

The diagnosis is no longer parametric. The diagnosis is **architectural**. We are asking you to redesign three pipelines together:

1. **compile / compile-all** — the local import path that walks a provider's history tree and produces the bundle.
2. **sync** — the protocol that promotes a local bundle to the remote server.
3. **query API** — the CLI / MCP / web / remote tRPC read surfaces, especially after a bundle has been promoted.

## License (what you may spend)

This redesign is allowed to spend resources freely in exchange for raw speed:

- **More storage** — replicated, packed, columnar, redundant indexes: all acceptable.
- **More memory** — large in-process caches, mmap-backed working sets, RAM-buffered batches.
- **More CPU** — heavier compression levels, signing, encoding, indexing during ingest.
- **More network bandwidth** — overlapping streams, redundant requests for tail latency, log shipping.
- **More operational complexity** — queues, snapshots, blob packers, dedicated workers, multiple stores.
- **More code** — splitting subsystems across processes, language boundaries (Rust extensions, Go workers), or services.

The single thing we ask you to optimize for is **wall-clock speed** on the three target pipelines, with secondary weight on **deterministic completion of no-op re-runs**.

## No backward compatibility

Explicit and important. **The redesign is not bound by the current shapes.** You may break:

- The local store schema (drop SQLite, replace tables, change indexes, change DDL set).
- The CAS hash family, compression, fanout layout.
- The bundle on-disk layout (replace `prosa.sqlite + objects/ + raw/` with whatever ships best).
- The sync protocol (handshake → plan → upload → commit → verify → cleanup may be discarded wholesale; tRPC may be replaced).
- The server database (Postgres + projection mirror may be redesigned, replaced with OLAP, or split).
- The object-store contract (`head/putIfAbsent/get/delete` may grow or shrink; server-side packed blobs are explicitly OK).
- The auth and tenant model (Better Auth + organizations may stay or go; multi-tenancy may be re-implemented).
- The read API shape (`reads.*` tRPC procedures may be redesigned).
- The MCP server (six tools may be redesigned, consolidated, or split).
- The CLI surface (command names and shapes may reorganize).
- The web console's data layer (we will rewrite it alongside the new server).

There is no third-party SDK to preserve. There is no legacy data we cannot rebuild from preserved raw bytes. Cutover is one-shot — no compatibility shims, no dual-write, no slow migration. **Do not propose backward-compat layers.**

## What must survive (the five invariants)

These are the only contracts that the new design must honor:

1. **Raw byte preservation.** Every byte of every imported source file must remain reconstructible from the bundle (local or remote). Importer bug fixes ship as re-projection from raw, never as re-import. Today this is `source_files.object_id` + `raw/sources/<blake3>.zst`; you may move the bytes elsewhere, but reconstructibility must hold.
2. **Idempotent re-imports.** Running compile twice over an unchanged input tree produces zero new rows, zero new objects, zero new files, and skips derived index rebuilds. The natural keys today are `(source_tool, path, size, mtime, content_hash)` per file and `(source_file_id, ordinal, raw_object_id)` per record, both as UNIQUE constraints. You may choose different keys but must preserve the property.
3. **Canonical event graph unification across five providers.** The bundle's `sessions`, `turns`, `events`, `messages`, `content_blocks`, `tool_calls`, `tool_results`, `artifacts`, and `edges` entities are filled from very different source formats and queried by code that doesn't care which provider generated which row. The unified shape is the product's reason to exist. You may change column names or split tables, but the cross-provider semantics (canonical tool types, role enum, edge taxonomy) must survive.
4. **Content-addressed deduplication.** Identical bytes from any source share one stored copy, keyed by a strong cryptographic hash. Today's hash is BLAKE3 over uncompressed bytes; you may switch families but must keep dedup by content.
5. **Signed promotion receipts.** A sync that completed must leave a server-signed receipt that names exactly what was promoted. Reads that route to the server must be able to point at a verified receipt as the source of authority for that store path. You may change the receipt format or the signing scheme, but the property — "the server proves cryptographically what it has" — must hold.

Everything else is rewritable.

## Expected deliverables

We expect a written design package with these artifacts, in roughly this order:

1. **High-level architecture diagram.** One diagram, one paragraph. Show the major components (local store, importer, sync engine, server, object store, read API, web/MCP frontends) and the data flows between them. State the deployment topology (single-region, multi-region, edge, embedded, etc.).
2. **Detailed protocol design with wire formats.** For the sync path: how does the client tell the server what it has? How does the server tell the client what it needs? What is the receipt? Specify the message shapes precisely enough that two teams could implement client and server independently and interoperate.
3. **Storage choices with justification.** For each surface (local store, remote OLTP, remote OLAP, object store, search index), name the engine you pick and explain why it fits the workload from §10. Specifically address: where the writer lock(s) live, how reads stay fast under concurrent writes, how to back up and restore.
4. **Concurrency / pipelining model.** Where does the compile-side throughput ceiling go? How do you reach > 50 MB/s sustained throughput on a laptop SSD without hitting a single-writer mutex? How do compile and sync share a pipeline — or do they? How do reads stay snappy under load?
5. **Target performance envelope with assumptions.** Restate the targets from §10 and assert which ones your design meets, which ones it overshoots, and which ones it misses. State the assumptions (network latency, S3 throughput, CPU cores, RAM, SSD bandwidth) under which your numbers hold.
6. **Migration plan.** One-shot cutover. No shims. Specifically: how do existing users get their bundle into the new shape (re-compile from raw? export-and-import? signed-receipt-only? something we haven't thought of)? How long does that migration take per user? What happens to old promotion receipts on the server?

## Questions we want you to answer along the way

These are the questions the existing team keeps circling back to without resolving. They are not assignments — they are conversation prompts. The best answer to most of them is probably "yes, and here's why" or "no, and here's why".

- **Where does the local writer lock go?** SQLite WAL serializes writers, and that ceiling is the largest single cost in compile today. Do you keep SQLite and shard it (one DB per provider, one DB per worker)? Do you replace SQLite (RocksDB, LMDB, embedded DuckDB, a custom CAS-only store)? Do you move the writer out of the import critical path (queue + async flush)?
- **Is the sync protocol still a four-stage per-batch cycle?** The current shape is plan → uploads → commit → verify, × 281 batches. Each of the 281 cycles pays four RTTs and two object-store HEAD waves *even when nothing has to upload*. Can verification be amortized across the whole sync? Can the bookkeeping be batched into one final receipt? Can the server reconstruct what it needs from a content-addressed manifest delta?
- **Should the sync model be log-shipping / CRDT / WAL replication / stream-of-records / something else?** The current model is "client tells server what it has, server tells client what it's missing, client uploads, server verifies". A log-shipping model would invert this: the local store emits an append-only log that the server consumes. A CRDT-style replication would let multiple machines write the same bundle without coordination. State which model fits prosa's workload (single-writer per bundle today, multi-machine same-tenant tomorrow) and why.
- **Can `verifyPromotion` be amortized?** Today every batch HEAD-checks every declared object's bytes. With 281 batches and tens of thousands of objects, this is the largest fraction of "empty" sync time. Can the verification become a single end-of-sync pass? A periodic background audit? A merkle-proof check that doesn't need an object-store HEAD?
- **Can compile and sync share a pipeline?** Today they are completely separate: compile writes to the bundle, sync reads from it and uploads. If the bundle is a streaming log, compile could emit the log and sync could ship it concurrently — no separate "read from disk and upload" pass. Is that a real win or just complexity?
- **Where does the read API authority live in steady state?** Today the CLI uses a local-vs-remote toggle based on a per-store promotion receipt. The web only talks to the remote. The MCP only talks to local. Is this split right? Should promoted bundles also have local read caches? Should the MCP have a remote mode? Should reads ever be served directly from the object store via signed URLs (skipping the API server)?
- **Is the canonical projection still SQL?** The five DuckDB analytics views are the user-facing shape. The projection is queryable from both SQLite (locally) and Postgres (remotely). Would a columnar store (Parquet + DuckDB everywhere, ClickHouse, Apache Iceberg) collapse the dual implementation? What would that cost on the OLTP / single-row reads side?
- **Can full-text search live in one place?** Today there are three engines (FTS5 local, Tantivy local, Postgres `search_doc` remote). Pick one. Or pick one local + one remote, but make the contract identical.
- **What happens to the CAS at scale?** A single tenant with multiple machines pushing into the same bundle path adds N×duplication on the local side. The remote dedups via `tenant_object`, but locally each machine carries its own copy. Should the local store reach into a shared cache (peer-to-peer, NFS, S3-mounted)? Should the server pack hot CAS objects into shard blobs to amortize per-object I/O?
- **What goes in the receipt?** The current `PromotionReceipt` carries counts and a manifest hash. Should it carry a merkle root over the whole bundle? Should it be queryable as an audit log of every promotion? Should it be signed by the user's device key as well as the server's?

## What we are not asking for

- A proof-of-concept implementation. We need a design, not code.
- A multi-cloud abstraction. Pick one cloud and one object store; we will swap later if needed.
- A pitch deck. Plain prose with diagrams is what we want.
- A retrospective on what went wrong. §09 is that retrospective; we are looking forward.

## How we will read your design

Probably twice:

- **First pass** — does the design honor the five invariants? Does the protocol survive a partial network failure? Does the local store survive a kill -9 mid-compile? Does the receipt prove what it claims to prove?
- **Second pass** — does the design meet the target metrics in §10? Where it doesn't, do you explain why, with numbers? Where it overshoots, do we believe the numbers?

If anything in documents 00–10 is unclear or contradictory, ask before designing around it. Better to spend a day clarifying than a week designing against a wrong assumption.

Thank you for taking this on.

---

*— prosa core team, May 2026*
