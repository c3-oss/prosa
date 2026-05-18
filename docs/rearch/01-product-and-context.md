# 01 — Product and context

## What prosa does

`prosa` is a local-first ingest, indexing, and search system for AI-agent conversation histories. It exists because the agent CLIs that engineers use day-to-day — Codex CLI, Claude Code, Cursor, Gemini CLI, Hermes — each persist their own conversation logs in incompatible shapes, in different on-disk layouts, with different idea of what a "session" or a "tool call" is. Prosa imports all of them, projects them into one unified graph of sessions / turns / events / messages / tool calls / tool results / artifacts, and exposes that graph to four kinds of consumers:

- A CLI (`prosa sessions`, `prosa search`, `prosa session show`, `prosa analytics`, `prosa query duckdb`, `prosa export`).
- A Model Context Protocol (MCP) server (`prosa mcp serve`) that lets agents query their own history via JSON-RPC.
- A web console (`apps/web`) that renders dashboards, transcripts, tool-call audits, and search results.
- A read API on the remote server (multi-tenant Postgres + object store) for users whose bundles have been promoted.

The local bundle is the primary mode. The remote server is optional and exists so that a user with multiple machines can promote their bundle to a shared, multi-tenant destination and read from it remotely.

## What "promotion" means

A successful `prosa sync` does three things:

1. Uploads all CAS bytes that the server does not yet have.
2. Upserts every canonical projection row (sessions, messages, tool calls, search_docs, etc.) into the server's tenant-scoped tables, keyed on `(tenant_id, id)`.
3. Has the server verify that all declared bytes and rows materialized correctly, sign a promotion receipt, and pin a `remote_authority` row mapping `(tenant_id, store_path)` to that receipt.

After a promotion, the CLI's `sessions list`, `sessions show`, `search`, and the web/MCP read paths all read from the server's tenant projection instead of the local bundle. The local bundle stays on disk by default (so re-imports stay idempotent) but can be purged with `--purge-bundle`.

## The empirical workload that produced this brief

A real `~/.prosa` bundle from a heavy user produced the following counts (numbers cited from internal sync-performance proposal `docs/sync-performance/05-mix-projection-types-per-batch.md`, May 2026):

| Entity | Count |
|---|---|
| Sessions | 3,141 |
| Source files | 3,173 |
| Raw records | 811,511 |
| Search docs | 291,498 |
| CAS objects | 834,333 |
| Total projection rows (excluding raw_records and search_docs) | ~1.1 M |

Bundle disk size: roughly 1.4 GB of compressed input across `~/.codex/sessions` (Codex, ~1.1 GB) plus `~/.claude/projects` (Claude Code, ~271 MB), plus the projected SQLite plus the CAS plus the Tantivy sidecar plus Parquet.

In chunked sync mode (the server enforces `maxObjectsPerPlan = 10000` and `maxRowsPerCommit = 10000`), this produces **~281 batches**: one per ~5–10k objects or rows. Each batch is a full plan→upload→commit→verify cycle and incurs four round-trips even when zero bytes are uploaded.

## The 2-hour sync incident

In May 2026 the project lead promoted this `~/.prosa` bundle from his MacBook to an external prosa API server hosted on AWS. The sync took roughly two hours wall-clock. The local network was unconstrained (gigabit residential to ISP, hundreds of Mbps to S3). MinIO benchmarks at the same time on the same machine sustained tens of MB/s. The slowness was not the bytes — most CAS objects were already on the server from prior partial syncs, so most batches reported `missingObjects = 0`. The slowness was the **per-batch RTT overhead** multiplied by 281 batches across many sequential phases, plus the per-call latency on the server's verification HEAD checks.

The team had already shipped, in roughly the preceding two weeks:

- `perf(core)`: WASM BLAKE3 (commit `c4d3b0f`) — ~31× faster hashing on 1 MB payloads.
- `perf(sync)`: HTTP keep-alive on S3 client (#39, `686621d`).
- `perf(sync)`: Better Auth cookie cache so each tRPC request skips a DB hit (#38, `7581ee6`).
- `perf(sync)`: CLI dedup + bundle-side query optimizations (#37, `8bcac0a`).
- `perf(sync)`: `commit-upload` batched lookups (#40, `c4e65af`).
- `perf(sync)`: manifest batch cache, bounded (#41, `4ba8925`).
- `perf(sync)`: batch projection upserts in `commit-upload` (#42, `3d5da96`).
- `perf(sync)`: producer-consumer read/upload pipeline with bounded memory (#44, `567fc0f`).
- `perf(sync)`: batch `tenant_object` lookup + concurrent HEAD checks in `find-missing-objects` while preserving manifest order (#45, `ddcb3ab`).
- `perf(sync)`: set-based object packs (#46, `e51da77`).
- `perf(sync)`: Zod overrides to avoid hot-path schema cost (#47, `7250067`).
- `fix(cli)`: hardened chunked sync retries with `AdaptiveUploadConcurrencyController` (`10b40d1`).
- `perf(core)`: SQLite PRAGMA tuning (`page_size = 16384`, `cache_size = -262144`, `mmap_size = 256 MiB`, `temp_store = MEMORY`, `wal_autocheckpoint = 20000`) — **compile-all wall-clock fell from 519 s to 329 s on the 1.4 GB workload, a 37 % reduction**.

The conclusion is that incremental tuning has reached the floor of the current architecture. The 281 sequential phases, the per-batch plan→upload→commit→verify protocol, the post-commit byte verification (HEAD on every promoted object), the single-writer SQLite WAL lock that defines compile throughput — these are architectural, not parameter problems.

## What success looks like for the redesign

The project lead is explicit about the willingness to spend resources. The new design may:

- Use multiple times the storage (replicated, packed, columnar — all acceptable).
- Use multiple times the memory (in-process caches, mmap, RAM-buffered batches).
- Use multiple times the CPU (heavier compression, signing, encoding, indexing).
- Use multiple times the bandwidth (overlapping streams, redundant requests for tail latency).
- Demand more sophisticated operational tooling (queues, snapshots, log shipping, blob packing).

What success looks like, in rough order of priority:

1. **Compile-all on a 1.4 GB workload completes in well under one minute**, not five and a half. The redesign should remove the SQLite WAL writer lock as the single-writer ceiling. The memory note states an in-house experiment with `worker_threads` over the current SQLite store yielded only a ~15 % improvement (350 s → 298 s) because every worker contends on the same WAL writer.
2. **A full sync of an unchanged bundle completes in seconds, not hours**. If 99 % of CAS bytes are already on the server, the protocol should know that and complete the bookkeeping in one or two round-trips, not 281.
3. **A full sync of a fresh 1.4 GB bundle completes in single-digit minutes**, dominated by network throughput, not by per-batch overhead.
4. **Query API latency** (CLI `sessions list`, web `/console/sessions`, MCP `search`) stays at human-perceptible speed (sub-200 ms p95 for paginated reads, sub-2 s for transcript loads of typical sessions) even when the server holds millions of rows across many tenants.

## What success does **not** require

- Backward compatibility with the current store schema. The bundle layout may change. The SQLite database may be replaced. The CAS hash algorithm, fanout, and compression policy may change.
- Backward compatibility with the current sync protocol. The handshake / plan / upload / commit / verify / cleanup sequence may be discarded. tRPC may be replaced. HTTP may be replaced.
- Backward compatibility with the current server schema. The Postgres tables may be redesigned, replaced with an OLAP system, or split across multiple stores.
- Backward compatibility with the current public API consumed by `apps/web` or external automation. The redesign team is allowed to rewrite the frontend's data layer.

The five invariants from §00 — raw preservation, idempotent re-imports, unified canonical graph across providers, content-addressed dedup, signed promotion receipts — are the only contracts that must survive.

## Deployment shape (current)

For context only, here is how prosa is deployed today:

- **Local**: TypeScript Node.js CLI run on user laptops (macOS and Linux). Reads native histories from `~/.codex`, `~/.claude`, `~/.gemini`, `~/.cursor`, `~/.hermes`. Writes its bundle to `~/.prosa`. Uses `better-sqlite3` (synchronous N-API bindings to SQLite). Uses `@oxdev03/node-tantivy-binding` (N-API binding to Rust Tantivy) for the optional sidecar search index. Uses `@duckdb/node-api` for Parquet export and ad-hoc analytics.
- **Remote server**: Fastify on Node.js, fronts Better Auth + a tRPC router. Talks to Postgres for metadata + projection mirror, and to one of three object-store adapters (in-memory for tests, filesystem, S3-compatible). The production target is S3 (or MinIO behind S3 API).
- **Web console**: Vite + React, mounts a TanStack Router app, fetches via tRPC client + React Query. Lives at `apps/web/`.

§02 covers each of these in more detail with the actual directory layout.
