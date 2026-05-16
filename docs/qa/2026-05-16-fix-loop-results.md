# QA fix loop results: web auth, CLI sync, remote reads

Date: 2026-05-16  
Environment: local Docker compose API/Postgres/MinIO, Vite web at `http://localhost:5173`, CLI through `pnpm dev -- ...`.

## Scope exercised

- Browser signup/login through the web console.
- CLI auth against the local API.
- CLI compile/sync using temporary stores and `--keep-local`.
- Browser navigation through dashboard, sessions, search, tool calls, analytics, and settings.
- Typecheck, focused tests, Docker API rebuilds, and final broad test/lint gates.

## Problems found and fixed

1. Web/API local origin and auth defaults were not friendly for local compose.

   Fixed by allowing local web origins, Better Auth trusted origins, and localhost defaults for the web/API development path.

2. Signup/login did not reliably land the user in a usable console state.

   Fixed by refetching auth state after login/signup and making the console choose/persist an effective active tenant for single-tenant users.

3. The tenant switcher showed weak/empty state for one tenant.

   Fixed by deriving the active tenant snapshot and role consistently. Verified browser shows `Prosa Loop Tenant` and `role: admin`.

4. CLI password login failed through fetch/browser-origin assumptions.

   Fixed by using a Node HTTP/HTTPS sign-in path for CLI auth and better tRPC error formatting.

5. Sync dry-run for `~/.prosa` exceeded single-batch limits.

   Fixed by adding client-side chunked sync for large bundles. Dry-run now reports `mode=chunked` instead of aborting.

6. Large `planUpload` hit Fastify body size limits.

   Fixed by increasing the API body limit for sync planning payloads.

7. MinIO/S3 object upload failed with `getaddrinfo ENOTFOUND prosa.minio`.

   Fixed by enabling path-style S3 addressing when an endpoint is configured.

8. Object uploads were too slow in the first chunked implementation.

   Improved by uploading missing CAS objects concurrently within each chunk.

9. A device became unauthorized for an open batch after syncing a different local store.

   Root cause: device authorization included mutable `store_path`. Fixed by authorizing devices by device/tenant/user/revocation state while preserving batch store-path consistency checks.

10. `compile --store <new-empty-dir>` required a manual `prosa init` first.

    Fixed so explicit stores are initialized by `compile` when appropriate.

11. Relative `--sessions-path` under `pnpm dev -- ...` resolved from `apps/cli` and silently imported zero files.

    Fixed by resolving relative user paths from `INIT_CWD` and failing early for nonexistent explicit paths.

12. Re-promoting equivalent raw records from a new temp store failed with `Conflicting raw record payload`.

    Root cause: raw-record sync payload included volatile `importBatchId`. Fixed by omitting it on the CLI and stripping legacy values server-side before comparison.

13. Search and analytics web pages initially failed or returned unimplemented remote responses.

    Fixed remote-authoritative search over promoted `search_doc` and basic analytics report responses.

14. Tool calls page showed empty even after syncing data with local tool calls.

    Root cause: remote read API was initially hard-coded empty, then the sync contract still did not promote tool calls/results. Fixed both: `toolCalls.list` reads verified rows, and CLI/API sync now promotes `toolCalls` and linked `toolResults`.

15. Session `Errors` count was wrong after tool promotion.

    Root cause: session counts considered any historical error result, while `toolCalls.list` uses latest verified result. Fixed session aggregation to match latest verified result semantics.

## Manual validation results

### Auth and console

- Browser signup completed and landed in `/console`.
- Tenant sidebar shows `Prosa Loop Tenant (prosa-loop-20260516-0054)`.
- User shows `prosa-loop-qa-20260516-0054@example.com`.
- Role shows `admin`.

### CLI auth

- `pnpm dev -- auth login --server http://localhost:3000 --email ... --password ... --json` succeeded.
- `pnpm dev -- auth status` showed an active authenticated tenant/device.

### Compile and sync temp store

Command shape validated:

```bash
TMP_STORE="$(mktemp -d /tmp/prosa-sync-final.XXXXXX)"
pnpm dev -- compile codex --sessions-path packages/prosa-core/test/fixtures/codex --store "$TMP_STORE" --overwrite
pnpm dev -- sync --store "$TMP_STORE" --keep-local --verbose
```

Observed result:

- Compile imported 2 source files, 14 raw records, 2 sessions, 2 tool calls, and 4 tool results.
- Sync succeeded with `rows=32`.
- Local temp store was kept.

### Browser reads after sync

- `/console/sessions` shows 2 sessions.
- Session tool counts show `1` and `1`.
- Session error counts show `1` for the error session and `0` for the success session.
- `/console/tool-calls` shows 2 rows: one error and one success.
- Tool calls `Errors only` filter shows 1 row.
- `/console/search` and `/console/analytics` render without the prior remote-v0 errors.

## Remaining limitations

1. Full `~/.prosa` sync was not run to completion in the interactive loop.

   The dry-run estimated about 281 batches for the real store. Early failures were fixed, but a full run may take a long time because the store has about 834k CAS objects and over 1M projected rows.

2. Messages/events/artifacts are still not promoted with verified row-level provenance.

   Session `messageCount` remains fail-closed at `0`, and session detail timeline remains empty for the fixture.

3. Sync progress UX for very large stores still needs work.

   The separate performance memo covers likely causes and recommendations.

## Related memo

- `docs/qa/2026-05-16-sync-performance-memo.md`

## Final automated validation

Final gates run after the fix loop:

- `pnpm typecheck`: passed, 7/7 tasks.
- `pnpm lint`: passed, 7/7 tasks.
- `pnpm test`: passed, 7/7 tasks.

Final broad test totals included:

- API: 21 test files passed, 1 skipped; 94 tests passed, 1 skipped.
- CLI: 20 test files passed, 1 skipped; 93 tests passed, 1 skipped.
- Web: 7 test files passed; 16 tests passed.
- Core, DB, storage, and sync package test suites passed.

Additional manual validation after the final API rebuild and temp-store sync:

- `sync` returned `rows=32`, confirming `toolCalls` and linked `toolResults` are promoted in addition to source files, raw records, sessions, and search docs.
- `/console/tool-calls` rendered 2 rows.
- `Errors only` on `/console/tool-calls` rendered 1 row.
- `/console/sessions` rendered tool/error counts as `1/1` for the error session and `1/0` for the success session.
