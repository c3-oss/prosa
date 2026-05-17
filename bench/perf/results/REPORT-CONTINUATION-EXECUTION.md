# Continuation Execution Report

Date: 2026-05-17

This report records the work done after the initial continuation review. The
goal was to turn review findings into corrected PR branches or safer
alternatives, with focused validation.

## PR Branches Updated And Pushed

| PR | Branch | New commit | Result |
| --- | --- | --- | --- |
| #38 | `perf/auth-cookie-cache` | `a048ec5 fix(auth): make cookie cache opt-in` | Cookie cache is no longer enabled by default. It is gated by `PROSA_AUTH_COOKIE_CACHE_MAX_AGE_SECONDS` with a 0-300 second window. |
| #40 | `perf/commit-upload-batched-lookups` | `0552ae4 fix(sync): verify commit bytes after fresh plans` | Removed the unsafe fresh-plan trust shortcut. Commit now keeps batched verification with `verifyBytes: true`. |
| #41 | `perf/manifest-batch-cache` | `e05d16c fix(sync): bound manifest cache and recheck catalog` | Added TTL + LRU + in-flight coalescing. Also fixed a remote-object catalog race exposed by tests. |
| #42 | `perf/projection-batch-upserts` | `b46d9ab fix(sync): preserve projection replay conflicts` | Replaced silent `DO UPDATE` semantics with bulk insert plus batched replay verification. Divergent replay returns conflict and leaves rows unchanged. |
| #44 | `perf/sync-read-pipeline` | `149777f fix(cli): harden sync upload pipeline` | Fixed abort/deadlock paths, buffer release, and added byte-bounded queue support. |
| #45 | `perf/find-missing-objects-batched` | `b509b1d fix(sync): preserve missing object order` | Batched lookup now preserves input manifest order even with concurrent byte checks. |

PR titles were also updated where the old title described unsafe or outdated
semantics:

- #38: `perf(auth): make Better Auth cookie cache opt-in`
- #39: `perf(storage): share S3 HTTP handler socket pool`
- #40: `perf(sync): batch commit object verification lookups`
- #42: `perf(sync): batch projection inserts with replay verification`

## Validation Run

### #37 `perf/cli-dedup-and-bundle-query`

No code changes in this pass. Focused validation on the existing PR worktree:

- `pnpm --filter @c3-oss/prosa typecheck` passed.
- `pnpm --filter @c3-oss/prosa lint` passed.

### #38 `perf/auth-cookie-cache`

- `pnpm --filter @c3-oss/prosa-api test test/config.test.ts test/storage.test.ts` passed.
- `pnpm --filter @c3-oss/prosa-api typecheck` passed.
- `pnpm --filter @c3-oss/prosa-api lint` passed.

Rationale: Better Auth `cookieCache` has documented delayed revocation semantics
and was not proven to optimize CLI bearer-token sync traffic. The safer
alternative is explicit opt-in config with a short bounded cache window.

### #39 `perf/s3-keepalive`

No source changes in this pass. Focused validation on the existing PR worktree:

- `pnpm --filter @c3-oss/prosa-storage test` passed: 25 tests.
- `pnpm --filter @c3-oss/prosa-storage typecheck` passed.
- `pnpm --filter @c3-oss/prosa-storage lint` passed.

Rationale: AWS SDK v3 already enables keep-alive by default. The PR is now framed
as shared handler/socket-pool budgeting, not as merely enabling keep-alive.

### #40 `perf/commit-upload-batched-lookups`

Subagent validation:

- `pnpm --filter @c3-oss/prosa-api test test/sync.test.ts` passed: 22 tests.
- `pnpm --filter @c3-oss/prosa-api typecheck` passed.
- `pnpm --filter @c3-oss/prosa-api lint` passed.

New regression: fresh zero-missing plan with backing bytes corrupted after plan
must fail commit with `412`.

### #41 `perf/manifest-batch-cache`

- `pnpm --filter @c3-oss/prosa-api test test/object-upload-hardening.test.ts` passed: 15 tests.
- `pnpm --filter @c3-oss/prosa-api typecheck` passed.
- `pnpm --filter @c3-oss/prosa-api lint` passed.

The focused suite exposed a real catalog-race issue: after
`INSERT ... ON CONFLICT DO NOTHING`, the object route must re-check the remote
catalog before attaching tenant object/location rows. The branch now does that.

### #42 `perf/projection-batch-upserts`

Subagent validation:

- `pnpm --filter @c3-oss/prosa-api test test/sync/projection-upserts.test.ts` passed: 4 tests.
- `pnpm exec biome check apps/api/src/trpc/routers/sync/projection-upserts.ts apps/api/test/sync/projection-upserts.test.ts` passed.

Local full typecheck in that worktree was blocked by unrelated pre-existing
dirty files outside the staged/committed #42 scope. Those files were not
committed or pushed. The #42 commit itself only touched:

- `apps/api/src/trpc/routers/sync/projection-upserts.ts`
- `apps/api/test/sync/projection-upserts.test.ts`

### #43 `perf/blake3-wasm`

No source changes in this pass. Focused validation and microbench on the existing
PR worktree:

- `pnpm --filter @c3-oss/prosa-core test test/cas/hash.test.ts` passed: 5 tests.
- `pnpm --filter @c3-oss/prosa-core typecheck` passed.
- `pnpm --filter @c3-oss/prosa-core lint` passed.

Microbench command imported `blake3Hex` and `blake3HexAsync` from
`packages/prosa-core/src/core/cas/hash.ts` with `@swc-node/register`.

| Size | Iterations | noble sync | hash-wasm async |
| ---: | ---: | ---: | ---: |
| 1 KiB | 16,384 | 308.174 ms / 51.9 MiB/s | 33.424 ms / 478.7 MiB/s |
| 64 KiB | 256 | 305.105 ms / 52.4 MiB/s | 23.382 ms / 684.3 MiB/s |
| 1 MiB | 16 | 300.789 ms / 53.2 MiB/s | 22.964 ms / 696.7 MiB/s |
| 4 MiB | 5 | 373.841 ms / 53.5 MiB/s | 28.766 ms / 695.3 MiB/s |

Caveat: this proves local throughput and compatible vectors, not full compile or
sync wall-time. It also does not prove CPU parallelism; it proves the WASM
implementation is much faster per hash on this machine.

### #44 `perf/sync-read-pipeline`

Subagent validation:

- `pnpm --filter @c3-oss/prosa test test/cli/sync/pipeline.test.ts` passed: 12 tests.
- `pnpm --filter @c3-oss/prosa typecheck` passed.
- `pnpm --filter @c3-oss/prosa lint` passed.

New regressions cover upload failure and read failure while readers are blocked
on a full queue, plus loaded-buffer release on abort/error paths.

### #45 `perf/find-missing-objects-batched`

Subagent validation:

- `pnpm --filter @c3-oss/prosa-api test test/find-missing-objects.test.ts` passed: 5 tests.
- `pnpm --filter @c3-oss/prosa-api typecheck` passed.
- `pnpm --filter @c3-oss/prosa-api lint` passed.

New regression covers out-of-order concurrent `head()` completion while the
returned `missingObjectIds` order remains the input manifest order.

## Remaining Caveats

- #42 still needs a clean-worktree full API typecheck or CI confirmation because
  the local Claude worktree contained unrelated dirty files that blocked a full
  run. Focused tests and file-level Biome passed.
- #39 still needs real S3/MinIO concurrency timing. The local package test suite
  confirms behavior, but not throughput benefit.
- #43 should be followed by an end-to-end compile/sync benchmark, because the
  microbench only isolates hash throughput.
- #38 is now safe by default but no longer claims an unconditional perf win.
  A bearer-token-specific benchmark is still required before enabling it in any
  production-like config.
- No Docker E2E suite was run in this pass. The sync/API PRs should still be gated
  by the Docker harness before merge.
