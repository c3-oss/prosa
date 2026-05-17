# Codex Continuation Review

Date: 2026-05-17
Scope: continuation of the profiling handoff and review of open perf PRs #37-#45.

Inputs reviewed:

- `bench/perf/HANDOFF.md`
- `bench/perf/results/REPORT-SUMMARY.md`
- `bench/perf/results/REPORT-CLI-1.md`
- `bench/perf/results/REPORT-CLI-2.md`
- `bench/perf/results/REPORT-API-1.md`
- raw preserved run notes and `pg_stat_statements` CSVs
- current `master` source code
- GitHub PR metadata and diffs for #37-#45
- subagent reviews for CLI/search, API/sync, importers, and methodology
- Perplexity-backed checks against Better Auth, AWS SDK v3, and PostgreSQL docs

## Bottom Line

The original work is useful and directionally correct, but some findings are
triage-grade rather than merge-grade. The strongest evidence is for duplicated
CLI execution and server-side sync roundtrip amplification. The weakest evidence
is for exact speedup percentages, Claude recompile skip attribution, and any PR
that trades correctness checks for throughput.

The safe merge order is:

1. #37 after adding/confirming chunked-path follow-up is tracked.
2. #45 after fixing deterministic output order and testing incremental/present-object cases.
3. #39 only if described as shared handler/socket-budgeting, not as merely enabling keep-alive.
4. #43 only after compatibility/bundling tests and an actual hash microbench.
5. #41 after cache bounds, miss coalescing, and full invalidation paths.
6. #40 only if commit byte verification remains equivalent to `master`.
7. #42 must be rewritten; current semantics are unsafe.
8. #44 must fix abort/deadlock and byte-bounded memory before merge.
9. #38 should not be merged as a sync CLI optimization without proof for bearer-token requests.

## Results: Correct, Corrected, Or Overstated

High confidence:

- CLI double execution is real. `apps/cli/src/cli/main.ts` still auto-runs and
  the bin shim also calls `runCli`. This is both perf and correctness impact
  because side-effecting commands can execute twice.
- Server sync has real roundtrip amplification. The API run captured 249,433 PG
  calls and 13,782 ms aggregate PG execution during a 120 s timeout window.
- `findMissingObjectIds` sequential lookup is a real scalability problem.
  Current `manifest.ts` calls `hasMaterializedObject` once per object.
- Per-upload manifest ownership check is real. `PUT /objects` and object packs
  validate via `sync_batch_object_manifest` for each object/entry.
- `commitUpload` projection insertion is N+1 at the application/PG roundtrip
  level. The source still inserts/verifies rows one at a time.

Corrected:

- The SQLite session turn-count query is a correlated subquery inside one SQL
  statement, not JS issuing N separate queries. On the preserved smoke bundle
  (3,500 sessions / 41,295 turns), local timings were near 0.01-0.02 s for both
  correlated and grouped variants. The rewrite is still reasonable, but this is
  not a top bottleneck from the preserved evidence.
- The hash hot path is BLAKE3. Frames under `@noble/hashes/blake2.js` are library
  implementation detail, not proof that the protocol uses BLAKE2. Do not change
  object ids, transport hashes, or receipts away from BLAKE3.
- The Claude recompile finding is probably misattributed. The run had
  `source_files_imported=1` and `source_files_skipped=974`. Current importer code
  returns before reading/flushing skipped files, so the 141 s `flushPending` frame
  likely belongs to the single imported/changed file or native SQLite work being
  charged to the JS caller. A zero-import re-run is needed.
- AWS SDK v3 Node keep-alive is already on by default. A PR adding a custom
  `NodeHttpHandler` should be judged by socket budget, shared handler behavior,
  explicit timeouts, and instrumentation, not by "enables keep-alive".
- Better Auth `session.cookieCache` is documented for cookie session caching.
  Official docs do not clearly document it as an optimization for `Authorization:
  Bearer` CLI traffic. The documented caveat is that revoked sessions can remain
  active until cookie cache expiry.

Overstated:

- End-to-end speedup percentages are not proven. The key runs are single-run,
  the largest sync timed out at 120 s, `sync.json` is empty, and source-map/profiler
  overhead was present.
- `pg_stat_statements` shows DB execution time, not wall time. In the API run,
  DB execution was only about 13.8 s of a 120 s wall window, so object-store,
  network, client-side scheduling, auth, and Node overhead must be measured by
  phase before claiming full sync gains.

## PR Review

| PR | Verdict | Notes |
| --- | --- | --- |
| #37 `perf(cli): eliminate duplicate runCli and correlated-subquery in sync read` | Mergeable with follow-up | Removing CLI auto-run is correct and urgent. The non-chunked session query rewrite is safe but low-impact on preserved data. The chunked `readSessionChunk` path still has the correlated query and should get a scoped CTE/join follow-up. |
| #38 `perf(api): enable Better Auth session.cookieCache` | Do not merge as-is | Official docs support cookie-cache tradeoffs, including revocation delay. They do not prove benefit for CLI bearer-token sync requests. Needs bearer-specific test measuring `getSession` DB calls and revocation behavior. |
| #39 `perf(storage): enable HTTP keep-alive on S3 client` | Reframe and benchmark | AWS SDK v3 already uses keep-alive and default `maxSockets=50` when no custom agent is supplied. This PR sets shared agents with `maxSockets=50`; the possible benefit is cross-instance socket reuse / global socket budget, not enabling keep-alive. Add timeout decisions and middleware timing before claiming perf. |
| #40 `perf(sync): batch tenant_object lookups, drop vestigial verify loop` | Blocked | The removed post-`verifyCommitObjectBytes` loop is not vestigial under current semantics: it ensures byte/location verification even when `canTrustFreshPlanForObjects()` returns true. Keep an equivalent verification or explicitly narrow the trust model with tests. |
| #41 `perf(sync): cache sync_batch_object_manifest lookups` | Direction good, blocked on hardening | Needs max size/LRU, miss coalescing, all invalidation paths, and deployment notes. Cache key includes tenant, batch, user, which is good. It must never be a source of authorization truth beyond short-lived optimization. |
| #42 `perf(sync): batch projection upserts` | Blocked, rewrite required | Current diff changes semantics from insert-or-verify to `ON CONFLICT DO UPDATE`, and its tests assert silent mutation. That breaks remote authority/idempotency. Safe pattern is bulk `INSERT ... ON CONFLICT DO NOTHING`, batched select for existing rows, compare all fields with current null/json/timestamp normalization, and throw `CONFLICT` on divergence. |
| #43 `perf(core): swap pure-JS blake3 for WASM variant` | Promising, needs proof | Keeps BLAKE3, which is correct. Needs bundle/runtime compatibility checks, golden vectors across Node versions/platforms, and microbench showing `hash-wasm` wins for this workload. `Promise.all` does not prove CPU parallelism if the WASM hash runs on the main thread. |
| #44 `perf(cli): producer-consumer pipeline for sync object upload` | Blocked | New queue can hang if upload fails while readers are blocked on full queue; abort wakes dequeue waiters but not enqueue waiters. Queue bound is item-count based rather than byte-count based, so large objects can inflate RSS. Needs failure/cancel integration tests and macrobench before merge. |
| #45 `perf(sync): batch tenant_object lookup in findMissingObjectIds` | Best next PR after small fix | Correct target and high leverage for `planMs`. Fix nondeterministic output order from concurrent `stillMissing.push`, preserve manifest order, and benchmark both cold-all-missing and incremental-most-present cases. |

## Safer Implementation Patterns

Projection rows:

- Preserve the existing contract: existing row must match incoming fields or the
  API returns conflict. Do not mutate remote projection rows to match the client.
- Use set-based insert for new rows: `INSERT ... SELECT FROM unnest(...) ON
  CONFLICT DO NOTHING`.
- Use a batched `SELECT ... WHERE id = ANY(...)` for existing rows and compare in
  TypeScript using the existing JSON/timestamp/null rules.
- Add regression tests where a second promotion with different session title,
  turn count, source file metadata, message fields, content block payload, event
  payload, and raw record payload returns `409` and leaves rows unchanged.

Object plan/commit:

- Batch the `tenant_object` prefilter but keep byte/location verification where
  current semantics require it.
- For `findMissingObjectIds`, return missing ids in the same order as the input
  manifest. This makes retries and receipts easier to reason about.
- Avoid raising `objectConcurrency` or `batchConcurrency` before plan/commit
  amplification is fixed; otherwise the API just saturates PG/S3 faster.

Manifest cache:

- Key by tenant, batch, user.
- Keep TTL short, add size cap/LRU, and coalesce concurrent misses for the same key.
- Invalidate on commit success, mark-failed paths, explicit cleanup, and any route
  that closes or mutates a batch.
- Treat cache as performance only; DB and object store remain authoritative.

S3:

- AWS SDK v3 already defaults to keep-alive in Node.
- Supplying a custom agent without `maxSockets` can accidentally change the
  socket budget; #39 sets `maxSockets=50`, preserving SDK default per origin.
- Consider explicit `connectionTimeout` and `socketTimeout`, plus SDK middleware
  spans around `HeadObject`, `PutObject`, and `GetObject` before tuning further.

Better Auth:

- `session.cookieCache` has a documented revocation-delay tradeoff.
- Official docs do not establish a bearer-token sync benefit. Measure the CLI path
  specifically before using it to reduce sync `getSession` queries.
- For sensitive operations, use `disableCookieCache` or keep maxAge very short if
  cookie cache is enabled.

## Additional Visibility To Add

Low-overhead first:

- `perf_hooks` marks around `planUpload`, object upload, commit, verify, auth,
  object-store operations, and projection upserts.
- Per-phase `pg_stat_statements_reset()` snapshots or query tags/comments so top
  SQL can be attributed to plan/upload/commit/verify.
- AWS SDK middleware timing for `HeadObject`, `PutObject`, `GetObject`, and retry
  count.
- Event loop delay and RSS metrics during sync.

Database:

- `EXPLAIN (ANALYZE, BUFFERS)` for the batched queries, not just aggregate
  `pg_stat_statements`.
- `auto_explain` in local Docker for slow statements.
- PostgreSQL 16 `pg_stat_io` if available, to separate buffer cache from disk I/O.

Runtime:

- `clinic doctor`, `clinic flame`, and `0x` for Node profiles without relying only
  on source-map-heavy V8 output.
- Linux follow-up with `perf` and eBPF/`bpftrace` to see native SQLite, fsync,
  socket, and kernel time that V8 profiles misattribute.
- OpenTelemetry or targeted tracing only after sampling/span limits are set, to
  avoid observer overhead.

## Experimental Plan

1. Re-run baseline on current `master`; the preserved reports were based on an
   older commit and some sync paths have moved.
2. Use fixtures that complete: small, medium, and real-sample bundles. A 120 s
   timeout is useful for stress, not for final throughput proof.
3. Run 5-10 repetitions per scenario without profilers for wall-time stats.
4. Run profilers separately from wall-time benchmark runs.
5. Test each PR independently against the same fixture and clean DB/MinIO volume.
6. After each PR, capture `planMs`, `uploadMs`, `commitMs`, `verifyMs`, PG calls,
   S3 calls/retries, event loop delay, and RSS.
7. Require sync/API E2E coverage for idempotency, cross-tenant isolation,
   divergent replay conflict, object byte mismatch, missing bytes, retry, and
   multi-device remote-read behavior.

## Immediate Next Actions

- Merge/fix #37 first because it removes a real double-execution bug.
- Patch #45 to preserve missing-id order and run focused tests.
- Rewrite #42 rather than trying to patch around `DO UPDATE`.
- Add measurement hooks before spending more time on #38/#39/#43 estimates.
- Reproduce Claude compile with `source_files_imported=0`; if fast, close the
  "skips still flush" finding as incorrect and profile the one-file append path.
