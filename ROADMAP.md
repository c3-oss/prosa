# Roadmap

Forward-looking work for prosa. Reference docs live under [`docs/`](./docs/).

## Future features

Parquet and analytics surfaces extend the existing canonical export. SQLite and CAS remain the source of truth; these items make Parquet and DuckDB easier to consume.

- **BI-friendly datasets** — denormalized datasets (`sessions.dataset.parquet`, `messages.dataset.parquet`, `tool_calls.dataset.parquet`, `errors.dataset.parquet`, `daily_activity.dataset.parquet`) generated alongside the canonical tables during `prosa export parquet`. Notebook and BI workflows read these without joining.
- **Incremental Parquet export** — skip rewriting tables that did not change since the last export. The current export rebuilds the full Parquet directory on every run; this becomes the cost driver for large bundles.
- **Sanitized Parquet exports** — `--sanitize {metadata|redacted|hashed|allowlist}` modes produce Parquet variants safer to share. The default export remains faithful to the bundle; sanitization is an explicit opt-in alongside it.

## Sync performance

Five proposals remain open after the 2026-05 perf push. Six siblings already
shipped via PRs #37–#47 (see git history for design rationale). Empirical
driver: a `~/.prosa` sync against local API + MinIO produced 834k CAS objects
across ~167 plan/commit cycles in the CAS phase alone, with most batches
reporting `missingObjects=0` but each still paying a fixed plan + commit
round-trip.

- **Parallel batch promotion (client)** — pipeline the per-batch loop in `promoteChunkedUpload` once aggregated receipts and a bytes-in-flight cap are in place. See [`docs/sync-performance/03-parallel-batches-cliente.md`](./docs/sync-performance/03-parallel-batches-cliente.md).
- **Mixed-type batch packing** — pack multiple projection types (and optionally CAS objects) into one commit, respecting topological dependencies. See [`docs/sync-performance/05-mix-projection-types-per-batch.md`](./docs/sync-performance/05-mix-projection-types-per-batch.md).
- **`POST /objects:bulk` pack endpoint** — replace per-object PUTs with packed multi-object uploads for missing-object batches. See [`docs/sync-performance/07-bulk-put-objects-endpoint.md`](./docs/sync-performance/07-bulk-put-objects-endpoint.md).
- **Per-phase metrics and progress** — replace "281 commits with rows=0" UX with phase timing, throughput, and ETA. See [`docs/sync-performance/10-per-phase-metrics-progress.md`](./docs/sync-performance/10-per-phase-metrics-progress.md).
- **Remote CAS pack blobs** — collapse per-object S3 keys into packed blobs with range-read indirection; orthogonal to client-side bulk PUT. See [`docs/sync-performance/12-remote-cas-pack-blobs.md`](./docs/sync-performance/12-remote-cas-pack-blobs.md).

## Server-sync hardening

The promotion path documented in [`docs/architecture/server-sync.md`](./docs/architecture/server-sync.md) ships with known gaps. Each item below names a concrete property still missing from the code.

- **Verified-promoted visibility flag** — `commitUpload` is atomic, but readers reach projection rows the moment a batch transitions to `committed`. No single flag separates committed-but-unverified data from verified-promoted data, so a successful `commit` followed by a failed `verifyPromotion` still exposes rows without a `remote_authority` receipt.
- **Streaming object upload** — `PUT /objects` aligns `bodyLimit` with `syncLimits.maxObjectBytes` and rejects decompression bombs early, but the route still buffers the full body in memory before hashing and forwarding to the object store. Peak RSS scales with `maxObjectBytes`. A streaming hash-and-forward pipeline removes that ceiling.
- **Chunked sync protocol** — `maxRowsPerCommit` is 10,000 and `maxObjectsPerPlan` is 5,000; bundles past either limit fail closed on both client and server. The protocol has no continuation token, batch-of-batches, or per-chunk receipt. Chunking lets large promotions resume across multiple requests.
- **Remote-authoritative reads for query, analytics, export, tui, mcp** — `sessions` and `search` route to the server when a tenant is active and the bundle is promoted; the other read commands fail closed on promoted stores unless the user passes `--local`. Adding remote backends for those five commands closes the gap.
- **Unified schema source** — the remote schema lives in two hand-maintained sources: `SCHEMA_SQL` in `packages/prosa-db/src/migrate.ts` and the Drizzle table definitions under `packages/prosa-db/src/schema/`. Startup verifies that ten required tables exist but does not check columns, indexes, or foreign keys, and there is no `drizzle/` migration tree. A single source plus column and constraint verification at startup removes the drift surface.
- **Hardened signup and device controls** — rate limits exist for `signupWithTenant`, `deviceCode`, `deviceToken`, and `inviteMember`, backed by an in-process memory bucket. Signup auto-signs in without CAPTCHA or email verification, the rate-limit store does not survive restart or horizontal scale, and device identity is a client-supplied name with no token, secret, or rotation. Any signed-in tenant member can spoof another device row by guessing its name.
