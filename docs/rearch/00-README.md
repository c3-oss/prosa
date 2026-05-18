# Prosa rearchitecture — handoff package

This directory is a self-contained briefing for cloud / network / distributed-systems specialists who will be asked to **redesign the prosa store and sync architecture from scratch**. You are not expected to have access to the source repository. Every fact, every SQL statement, every wire format, every measured number you need to do the redesign should appear verbatim in these documents.

The terminal deliverable is `11-rearchitect-prompt.md`. Read it last — it is the actual brief the project lead will send to the redesign team. Documents `00`–`10` exist to make that brief intelligible.

---

## Why this package exists

In two weeks the prosa team shipped roughly twenty-five performance-focused commits (PRs #37–#47, plus several `fix(sync)`/`perf(core)` follow-ups). The merged work covered batched lookups, manifest caches, S3 keep-alive, WASM BLAKE3, producer-consumer pipelines, set-based object packs, adaptive upload concurrency, and SQLite PRAGMA tuning. Despite this, a single local-to-remote sync on the project lead's machine still took **roughly two hours**.

The interpretation is no longer "we need another round of tuning". The interpretation is that the **store contract and the sync protocol are themselves the bottleneck**, and incremental work can no longer move them. Three pipelines must be redesigned together:

1. **compile / compile-all** — local import of agent histories into the prosa bundle.
2. **sync** — promotion of a local bundle to a remote, multi-tenant server.
3. **query API** — CLI, MCP, and web reads, especially after a store has been promoted to remote-authoritative state.

The redesign is allowed to spend **more disk, more memory, more CPU, more network, more code, more operational complexity** in exchange for raw speed. Backward compatibility is explicitly **not** required: the store schema, the sync protocol, the server database, and the frontend data layer may all change shape.

Five invariants survive the redesign and constrain it. They are the only contract that must hold across the new system. They are stated again, more formally, in §10:

- **Raw byte preservation.** Every byte of every imported source file must remain reconstructible from the bundle (local or remote). Importer bugs must be fixable by re-projection, never by re-import.
- **Idempotent re-imports.** Compiling the same input twice must produce no new rows, no new objects, and skip derived-index rebuilds.
- **Canonical event graph unification.** Five very different agent providers (Codex CLI, Claude Code, Cursor, Gemini CLI, Hermes) project into a single graph of sessions / turns / events / messages / tool calls / tool results / artifacts / edges. The new architecture keeps that unification.
- **Content-addressed deduplication.** Identical bytes from any source share one stored copy, addressed by a strong hash.
- **Signed promotion receipts.** A bundle that has been promoted to the server carries a verified, server-signed receipt that names exactly what was promoted. Subsequent reads honor that receipt as the authority boundary.

---

## Audience and intended use

These documents target two reader profiles:

- **Software architects** who will own the new design — they need every constraint, every measured number, every prior attempt's outcome, and every component boundary.
- **Cloud / network / distributed-systems specialists** consulted for protocol shape, storage choice, and concurrency model — they need the wire formats, the storage interfaces, the deployment topology, and the workload characteristics.

Neither audience has access to the repository. Both audiences can write code in TypeScript, Rust, Go, or any other language; the redesign is not constrained to the current stack.

Read top-to-bottom on first pass. Use the index below to jump back when reading the prompt in §11.

---

## Index

| # | Title | What you will find |
|---|---|---|
| 00 | This README | Audience, invariants, glossary, reading order. |
| 01 | [Product and context](./01-product-and-context.md) | What prosa does, who runs it, the empirical workload that produced the 2-hour sync, what success looks like. |
| 02 | [Repository layout](./02-repo-layout.md) | The monorepo today: three apps (`api`, `cli`, `web`) plus four shared packages. Per-directory responsibilities. |
| 03 | [Store architecture](./03-store-architecture.md) | The on-disk bundle, the full SQLite DDL (17 tables, 5 views, FTS5 virtual table and triggers, 5 migrations), the CAS, the three-layer model, every PRAGMA, every idempotency key. |
| 04 | [Compile pipeline and importers](./04-compile-and-importers.md) | The five importers, the discover / parse / CAS-stage / domain-insert pipeline, the FK insertion order, batch tracking, mermaid flow. |
| 05 | [Search and analytics sidecars](./05-search-and-analytics.md) | FTS5 (always full rebuild), Tantivy (incremental + schema fingerprint, 300 MB / 4-thread writer), Parquet (zstd-1, ROW_GROUP=100k), the five DuckDB analytics views, sidecar refresh rules. |
| 06 | [Sync protocol](./06-sync-protocol.md) | The full client→server promotion sequence (handshake → planUpload → object pack/PUT uploads → commitUpload → verifyPromotion → ackCleanup), the binary object-pack wire format, the chunked / checkpointed mode, adaptive upload concurrency. |
| 07 | [Server architecture](./07-server-architecture.md) | The Postgres schema (sync bookkeeping, CAS catalog, tenant access grants, projection mirror), the object-store adapter (memory / fs / s3), the Better Auth + organization tenant model, every tRPC `sync.*` endpoint, the HTTP object routes. |
| 08 | [Read paths and query API](./08-read-paths-and-query-api.md) | Remote-authoritative-read decision tree, per-command remote support matrix, tenant-verified projection gates, server tRPC reads (sessions / search / tool-calls / transcript / artifacts / analytics), MCP tools, the web data layer, the local DuckDB / Parquet path. |
| 09 | [Performance history](./09-performance-history.md) | Every recent commit and PR with its measured effect; what was tried and abandoned (worker_threads compile, batched outer transaction with savepoints) and why. |
| 10 | [Bottlenecks, invariants, and targets](./10-bottlenecks-and-targets.md) | A short list of where time is actually spent today, a two-column table of "must hold" vs "explicitly allowed to break", concrete target metrics for the new system. |
| 11 | [Rearchitect prompt](./11-rearchitect-prompt.md) | The prompt the project lead sends to the redesign team. Reading it cold should be enough to start designing if you have already read 00–10. |

---

## Glossary (terms used throughout)

- **Bundle**: a local directory (default `~/.prosa`) that holds the canonical projection of imported agent histories plus the raw bytes they came from. The on-disk shape is detailed in §03.
- **CAS**: content-addressed storage. Every reusable byte string is stored once, keyed by the BLAKE3 hash of its uncompressed bytes. The on-disk path is `objects/blake3/<aa>/<bb>/<hash>.zst`.
- **Raw layer / canonical projection / derived layer**: the three-tier model. Raw is immutable source of truth; canonical projection is regenerable from raw; derived (search indexes, Parquet, exports) is disposable.
- **Source tool / provider**: one of `codex`, `claude`, `cursor`, `gemini`, `hermes`. Each is an agent CLI whose conversation history prosa imports.
- **Session / turn / event / message / tool_call / tool_result / artifact / edge**: the canonical projection entities. See §03 for the schema.
- **Compile**: importing one provider's tree into the bundle (`prosa compile <provider>`). `compile-all` runs every provider sequentially.
- **Promotion / sync**: uploading a local bundle to the remote API server (`prosa sync`). The end state is the server holding a verified, signed receipt for the bundle's `storePath`.
- **Remote-authoritative**: state of a store path after a successful promotion. Reads for that store path now go to the server, not the local bundle.
- **Manifest / receipt**: the manifest is the per-batch declaration of which objects and projection rows are being promoted. The receipt is the server-signed verification of that manifest after upload.
- **Chunked sync**: the mode used when a bundle is too large for a single planUpload. Objects and projection rows are split into many batches; each batch is a complete plan→upload→commit→verify cycle.
- **MCP**: Model Context Protocol. The prosa CLI exposes an MCP server so agents (Claude Code, etc.) can read the local bundle via JSON-RPC over stdio or HTTP.

---

## Conventions

These conventions are honored across all eleven documents:

- **English only.** No translated terms.
- **Verbatim DDL and code excerpts** in fenced blocks, with the repo-relative path on the line above (e.g. `// packages/prosa-core/src/core/db.ts`). The reader cannot open the repo, so paraphrased code is useless.
- **Mermaid diagrams** for: the three-layer model, the per-file compile pipeline, the full sync sequence, the server data model, the read-path topology, the deployment topology.
- **Cross-references by document number** (e.g. "see §06"), not by file path.
- **Numbers with units.** "256 MiB cache" not "big cache"; "37 % (519 s → 329 s on 1.4 GB of input)" not "much faster".
- **No claims of forward direction.** This package describes what *is*, not what *should be*. The "should be" question belongs in §11.

When in doubt, prefer over-quoting code to summarizing it. The package is a reference, not a tutorial.
