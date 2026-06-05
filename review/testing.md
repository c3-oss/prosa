# Review: Testing (Strategy, Coverage, Quality)

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: All *_test.go, fakes, fixtures, justfile test tasks

## Coverage snapshot

Aggregate coverage from `go test -coverprofile=… ./...` (equivalent to
`just cover`):

```
total: 36.1% of statements
```

Per-package, sorted by health:

| Package | Coverage |
| --- | --- |
| `internal/projectlabel` | 100.0% |
| `internal/sessiontext` | 94.8% |
| `internal/pricing` | 92.7% |
| `internal/panel/render` | 79.3% |
| `internal/cli/spinner` | 78.0% |
| `internal/projectid` | 77.4% |
| `internal/importers/claudecode` | 75.9% |
| `internal/importers/gemini` | 74.5% |
| `internal/importers/codex` | 74.1% |
| `internal/legacy` | 73.0% |
| `internal/importers/hermes` | 72.9% |
| `internal/importers/antigravity` | 62.7% |
| `internal/cli/browser` | 57.1% |
| `internal/store` | 56.7% |
| `internal/importers/cursor` | 54.7% |
| `internal/cli/render` | 51.5% |
| `internal/device` | 47.5% |
| `internal/cli/schedule` | 35.3% |
| `internal/panel` | 27.5% |
| `internal/cli` | 19.8% |
| `pkg/session` | 16.7% |
| `internal/server/auth` | 13.6% |
| `internal/server/handlers` | 2.1% |
| `cmd/prosa`, `cmd/prosa-panel`, `cmd/prosa-server` | 0.0% (no tests) |
| `internal/buildinfo` | 0.0% (no tests) |
| `internal/cli/rpc` | 0.0% (no tests) |
| `internal/importers/importpolicy` | 0.0% (no tests) |
| `internal/panel/{assets,oauth,rpc,session,templates}` | 0.0% (no tests) |
| `internal/paths` | 0.0% (no tests) |
| `internal/server` | 0.0% (no tests) |
| `internal/server/storage` | 0.0% (no tests) |
| `migrations/{local,server}` | 0.0% (no tests, expected) |
| `pkg/httpserver` | 0.0% (no tests) |
| `pkg/importer` | 0.0% (no tests — helpers `PreviouslySkipped`/`RecordSkip` uncovered) |

`just test`, `just test-race`, and `just cover` all run cleanly:

```
go test -race -count=1 ./...      → PASS, no race reports
go test -coverprofile=… ./...     → PASS
```

## Test inventory

- **51** `*_test.go` files, **350** top-level `TestXxx` functions, ~8.7k
  LoC of tests against ~21.7k LoC of production Go (ratio ≈ 40%).
- **Zero `testdata/` directories** in the entire tree. Every importer
  fixture is constructed inline from `t.TempDir()` (see
  `buildHermesStateDB`, `buildFixtureStore`, `makeAntigravityFixture`,
  `writeJSONLFixture`, `writeFixtureBundle`, etc.). That's actually a
  strength — no golden-file rot — but it shifts the burden onto the
  test bodies to stay synced with parser changes.
- **Zero `Fuzz*` targets**. The codebase has six structurally different
  importer parsers (JSONL/JSON/SQLite/protobuf) all hand-written and
  every one is exactly the kind of input that fuzzing was designed for.
- **Zero `testcontainers` / `dockertest`** usage. Postgres-backed tests
  rely on `PROSA_TEST_PG_URL` and skip when not set; CI presumably runs
  with a Postgres available, but locally `just test` exercises *none* of
  the real Postgres paths.
- Biggest test files: `codex/importer_test.go` (748 LoC),
  `claudecode/importer_test.go` (706), `hermes/importer_test.go` (526),
  `cli/sync_reconcile_test.go` (487), `antigravity/importer_test.go`
  (387), `gemini/importer_test.go` (351), `cursor/importer_test.go`
  (333), `store/search_test.go` (311).
- Six importers each carry a self-contained `inMemSink` — same name,
  similar shape, *not* unified into a shared `importertest` helper.

## Summary

The overall posture is honest: the layers that the project depends on
most (parsers, store reads, importer happy paths) get real integration
testing against `t.TempDir()` SQLite and disk fixtures. The `_test.go`
files double the typical happy-path with idempotency re-imports,
sanitization edge cases, and end-of-stream branches. Race detector is
clean, files use `t.TempDir()` and `t.Setenv` consistently, and there
is genuinely no mocking-framework rot.

But there's a class of false-positive that the in-memory sinks let
through, and the 114f89a fix exposed exactly one instance of it. **The
same shape exists in five other importers' tests.** Specifically: the
`no_usage` skip-cache path. Every importer except hermes uses an
`inMemSink` that *does not* implement `importer.SkipCache`. The
`pkg/importer.PreviouslySkipped`/`RecordSkip` helpers silently no-op
when the type assertion fails, which means:

- Tests assert `res.Skipped == true, res.SkipReason == "no_usage"` and
  pass. ✓
- Production behavior (record the skip so a *second* sync doesn't
  re-parse the same zero-usage transcript) is **never exercised**.
- A bug that breaks skip persistence — exactly the family of bugs that
  114f89a fixes for `state.db` — is invisible to CI.

This is the weakest layer. After that, server/HTTP handler tests
(2.1%), CLI command-level tests (no black-box CLI driver), down-migration
tests (none), and projection-version reprojection tests (none) follow
in roughly that order.

## Findings

### critical

**1. `inMemSink` doesn't implement `SkipCache` in 5 of 6 importers, and
the no_usage skip path is asserted as a green path despite being a
silent no-op.**

Files (the in-memory sinks):
- `internal/importers/claudecode/importer_test.go:22-58`
- `internal/importers/codex/importer_test.go:28-64`
- `internal/importers/cursor/importer_test.go:26-61`
- `internal/importers/gemini/importer_test.go:22-57`
- `internal/importers/antigravity/importer_test.go:27-62`

Production code that depends on the cache being honored:
- `pkg/importer/importer.go:89` (`PreviouslySkipped`)
- `pkg/importer/importer.go:101` (`RecordSkip`)
- `internal/importers/{claudecode,codex,cursor,gemini,antigravity}/importer.go`
  (every `RecordNoUsageSkip` + `PreviouslySkippedNoUsage` call site)

Tests that pass while actually exercising nothing of the skip
persistence:
- `internal/importers/claudecode/importer_test.go:387-424`
  (`TestImportSkipsSessionWithExplicitZeroUsage`)
- `internal/importers/codex/importer_test.go:521-571`
  (`TestImportSkipsSessionWithExplicitZeroUsage`)
- `internal/importers/gemini/importer_test.go:240-275`
  (`TestImportLiveLogsSkipsWithExplicitZeroUsage`)

What happens at runtime:

```go
// pkg/importer/importer.go
func PreviouslySkipped(...) (bool, error) {
    cache, ok := sink.(SkipCache)
    if !ok { return false, nil }      // ← inMemSink falls in here
    ...
}
func RecordSkip(...) error {
    cache, ok := sink.(SkipCache)
    if !ok { return nil }             // ← silent no-op
    ...
}
```

The test calls `Import`, the importer detects explicit-zero usage,
calls `importpolicy.RecordNoUsageSkip` → `importer.RecordSkip` → the
type-assert fails → the function returns nil → the test sees
`res.Skipped == true` and asserts on it. Done. **Nothing has been
recorded.** A real `store.Store` would have written a row to
`import_skips`; the fake silently dropped the call. If the production
code grew a bug that *didn't* call `RecordSkip` at all (or called it
with the wrong session id, or threw an error), these tests would still
pass.

This is the exact failure mode 114f89a fixed for hermes' state.db.
The hermes test (`importer_test.go:31-88`) is now the *only* importer
test that actually exercises the round trip.

**Fix shape:** Promote the SkipCache implementation in
`internal/importers/hermes/importer_test.go:74-88` into a shared test
helper (e.g. `internal/importers/importertest/sink.go`) and switch
every importer test to it. While there, add an explicit
double-`Import` assertion to every `TestImport*Skip*` test that
verifies `sink.skips[id]["no_usage"] == hash` after the first call
**and** that the second call short-circuits at the cache layer
(i.e. that the parser is not re-invoked).

---

**2. No test exercises the projection-version reprojection path on the
local store.**

Files:
- `internal/store/sync_state.go:31-34` and `:70-73` (the
  `projectionVersion < session.ProjectionVersion → return found=false`
  reprojection trigger)
- `pkg/session/types.go:106` (`ProjectionVersion = 8`)

Production behavior: when `ProjectionVersion` bumps, the next sync
sees the old `sync_state`/`import_skips` rows, returns `found=false`,
re-parses every transcript, and re-upserts everything. This is the
mechanism by which a `Usage` field addition rolls out across history.

Tests against the local store (`internal/store/sync_state.go`-callers)
never assert this. `TestSyncStateRoundTrip`
(`internal/store/store_test.go:146-166`) only checks that
`RecordSync` → `LastHash` round-trips at the *current* version. The
manifest tests in `sync_reconcile_test.go` use
`ProjectionVersion: int32(session.ProjectionVersion)` for the *remote*
manifest entries but never set a lower version, so the
"local-version-is-older → push" branch in `pusher` is exercised, but
the "stored-version-is-older → re-parse" branch in the local Store is
not. A regression where `LastHash` or `LastImportSkip` accidentally
returned `found=true` despite a stale projection_version would slip
past CI and quietly break re-projection in the field.

**Fix shape:** Add a `TestLastHashIgnoresStaleProjectionVersion` (and
the same for `LastImportSkip`) that manually inserts a row with
`projection_version = session.ProjectionVersion - 1` and asserts
`found == false`.

---

**3. The Postgres `auth` test schema is duplicated in Go rather than
loaded from the real migration; the two can drift.**

Files:
- `internal/server/auth/login_test.go:233-265` (`postgresAuthTestSchema`)
- `migrations/server/0001_init.up.sql` (CREATE TABLE devices,
  device_tokens — see also indexes that are *not* in the test schema)
- `migrations/server/0009_auth_codes.up.sql` (CREATE TABLE auth_codes
  - two indexes — also missing in the test schema)

The test schema is roughly accurate today but stripped of the
production indexes (`devices_revoked_idx`,
`device_tokens_device_idx`, `auth_codes_code_idx`,
`auth_codes_expires_at_idx`). If a future migration adds a NOT NULL
column with no default, or renames a column, or adds an index that
the query relies on for correctness (e.g. a partial unique index),
the test will keep passing against the stale copy.

**Fix shape:** Replace `postgresAuthTestSchema` with a loader that
applies `migrations/server/` in order. The `migrations/server`
package already has an `embed.go` (referenced by the production
loader) — point the test at the same `embed.FS`. The auth test is
also the *only* place that runs Postgres at all, so anchoring it to
the real migrations doubles as the only smoke test of the migration
chain.

### high

**4. Server / handlers / RPC plumbing is essentially untested (2.1%
coverage in `internal/server/handlers`, 0% in `pkg/httpserver`,
`internal/server/storage`, `internal/server`, `internal/cli/rpc`,
`internal/panel/rpc`, `internal/panel/session`,
`internal/panel/oauth`).**

What's missing concretely: there are zero `httptest.NewServer`-style
end-to-end tests of `prosa-server`'s Connect endpoints. The fake-RPC
tests in `internal/cli/sync_reconcile_test.go` exercise the *client*
half of the wire format, but no test wires a real handler against a
real store and asserts that, say, `Manifest` returns what the CLI
expects. A regression to the server's response shape (a missing
field, a swapped enum, an off-by-one cursor) would not be caught
until a manual `prosa sync` in dev. The Panel side gets significantly
more httptest coverage
(`internal/panel/handlers_*_test.go`), so the pattern is doable; it
just hasn't been replicated on the server side.

**5. No CLI black-box / end-to-end tests.**

Files:
- `cmd/prosa/main.go` (0% coverage)
- `internal/cli/*.go` (19.8% coverage, all function-level)

There is no test that does `os/exec.Command("./bin/prosa", "list",
"--since=2026-01-01")` and asserts on stdout/exit code. Every CLI
test in `internal/cli/` calls an internal helper directly
(`pushSession`, `reconcileWithServer`, `DetectProject`,
`parseSince`). Cobra wiring, flag parsing, exit codes, the
`--overwrite` flag's interaction with the full sync pipeline, the
spinner integration, the read-only store fallback messaging — none of
that is in CI. The release path *does* run snapshot builds via
GoReleaser, but it doesn't smoke-test the binary.

**6. No down-migration tests.**

Files:
- `migrations/local/000?_*.down.sql` (eight pairs, never applied in CI)
- `migrations/server/000?_*.down.sql` (nine pairs, never applied)
- `internal/store/migrations.go:20` (`migrate` only applies `.up.sql`)

If a developer adds a `0009_*.down.sql` for the local store and
forgets to actually make it the inverse of the up migration, CI
won't catch it. There is no `migrate up → migrate down → migrate up`
identity test. Given that prosa explicitly stores `last_hash` and
`projection_version`, an asymmetric down migration that drops the
column without restoring it from history would be a hard data loss
event during a rollback.

### medium

**7. Time is hardcoded — `time.Now()` is called in 19 production files
with no injection point.**

Spot-check: `internal/panel/panel_time_test.go:8-17`'s `TestRelativeTime`
captures `time.Now()` once and then calls `relativeTime(now.Add(-30*time.Second))`. If a GC pause or a slow runner stretches the gap
between line 10 and line 11 beyond a few seconds, the assertion
`relativeTime(now.Add(-30*time.Second)) == "just now"` may flake.
Same shape in:
- `internal/cli/spinner/sync_test.go:25-26` (`time.Now().Add(-3 *time.Second)`)
- Several store-level test seeds use `time.Now().UTC()` and then bin
  things into `Add(-time.Hour)` windows that are unlikely to flake but
  are not deterministic.

A `var nowFn = time.Now` package variable that tests can swap to a
fixed clock would eliminate this entire class of subtle staleness.
Not urgent, but every place the spec mentions "30 days" or "since X
hours ago" benefits from injectable time when running on a slow CI
machine or under `-race`.

**8. No FK negative test in `internal/store`.**

The store relies on SQLite foreign-keys (`store.go:54` sets
`_pragma=foreign_keys(ON)` and migrations declare `REFERENCES`).
There is no test that confirms FK enforcement is actually on. The
114f89a bug was discovered because of this exact gap — a test that
deliberately `INSERT INTO sync_state(...) VALUES('does-not-exist',
'x', '..', 8)` and asserts `Error` would have caught the bug
preemptively.

**9. `TestImportRealAntigravityDB` and `TestDebugGenMetadataSnapshot`
are diagnostic tests that never assert.**

Files:
- `internal/importers/antigravity/importer_test.go:307-348`
- `internal/importers/antigravity/importer_test.go:351-388`

Both `t.Skip` when `PROSA_TEST_ANTIGRAVITY_DB` is unset (good), but
when set, they only `t.Logf` and assert `res.Skipped == false`. They
look like assertions but they're really "print the output for me to
eyeball." If antigravity parsing silently regresses on a real
conversation — say, model field decoding goes back to empty — this
test will still pass. That's fine for a developer convenience hook,
but they should be renamed to make their intent obvious
(e.g. `TestDebugAntigravityRealDB`) or moved to a `debug_test.go` file
behind a build tag so they don't show up under `go test ./...`.

**10. Only 7 of 51 test files use `t.Parallel()` (panel/auth/handlers
only).**

Files using `t.Parallel`:
- `internal/cli/browser/open_test.go`
- `internal/panel/handlers_auth_test.go`
- `internal/panel/handlers_sessions_sort_test.go`
- `internal/panel/panel_time_test.go`
- `internal/panel/git_remote_test.go`
- `internal/server/auth/login_test.go`
- `internal/server/handlers/sessions_sort_test.go`

Many store/ and importer tests are read-only or each use their own
`t.TempDir()` SQLite, so they're trivially parallelizable.
Parallelizing them shortens the longest pole (`internal/store` takes
7.86s under `-race`) and would more aggressively shake out latent
shared-state bugs.

### low

**11. The `inMemSink` definition is copy-pasted across six test
files.** Even after Finding 1 is addressed, the structure
(`sessions`, `tools`, `turns`, `hashes`) is duplicated verbatim.
Promote to `internal/importers/importertest`.

**12. The Postgres auth integration tests skip by default but offer no
way to run them via `just`.** A `just test-integration` task that
spins up Postgres via Docker (or hooks `testcontainers-go`) would
make it less likely the tests stay dormant.

**13. No fuzz targets.** Six hand-rolled parsers (JSONL, JSON,
SQLite-blob, protobuf-wire), some of them parsing untrusted bytes
from disk:
- `internal/importers/{claudecode,codex,gemini,hermes,cursor,antigravity}/parse.go`
- `internal/importers/antigravity/proto_test.go` (already has hand-built
  protobuf payloads via `protowire` — almost halfway to a fuzz target)

Even a 30s `go test -fuzz` per parser on PRs would catch the bulk of
panic-on-malformed-input regressions.

**14. Pricing table coverage is high (92.7%) but pricing is also one
of the dimensions that drifts most. The tests treat the table as
authoritative — if a model's price changes in `internal/pricing/`,
the test will validate that the *new* number matches the *new*
number.** Consider a golden test that pins a small canonical
session's `ClassifyUsage` cost to a known dollar amount (anchored to
a specific catalog version), to make pricing-table changes show up as
explicit test diffs rather than silent updates.

### nit

**15. Test naming is generally clear, but `TestParseFields*`,
`TestFindField`, `TestReadTimestampGoogleShape` in
`internal/importers/antigravity/proto_test.go` use bare names. They
should still pass `go test -run TestParseFields` searches, so this is
cosmetic — flagging only because the rest of the suite uses
descriptive `TestImportXxx` patterns.

**16. `internal/cli/window_test.go` uses raw `t.Errorf` instead of
`require`. Mixing styles across the same package — most CLI tests use
`require`, but `window_test.go` is hand-rolled — makes failure
output inconsistent.** Either is fine, but pick one per package.

**17. `relativeTime` in `internal/panel/panel_time_test.go:11` uses
`time.Now()` twice with a fixed offset; if the runner hiccups, this
can theoretically flake. See Finding 7.**

## What I checked

- Ran `go test -race -count=1 ./...` from the repo root — clean pass,
  ~30s wall time, longest packages: `internal/store` (7.86s),
  `internal/importers/claudecode` (6.58s), `internal/cli` (4.98s).
- Ran `go test -coverprofile=… ./...` — aggregate **36.1%**, breakdown
  table above. The 0% packages are mostly entrypoint shells
  (`cmd/*`), generated code (`gen/`), or stateless plumbing that the
  test author would have to substantially mock around (HTTP server
  glue, Postgres handlers).
- Inventoried all `*_test.go` files (51), all `func Test*` symbols
  (350), and every `t.Skip`, `t.Parallel`, `t.Setenv`, `t.TempDir`,
  `t.Cleanup`, `testing.F` (none), `require.`/`assert.` use, and
  `t.Fatal` style.
- Audited every importer's `inMemSink` against
  `pkg/importer/importer.{Sink,SkipCache}` and traced every call site
  of `RecordNoUsageSkip` / `PreviouslySkippedNoUsage` /
  `importer.RecordSkip` / `importer.PreviouslySkipped` to confirm the
  silent-no-op gap is real.
- Walked the local migrations chain (8 ups, 8 downs), the server
  migrations chain (9 ups, 9 downs), and the test that holds an
  inline Postgres schema (`login_test.go:233-265`).
- Read `pkg/session/types.go:106` to confirm `ProjectionVersion = 8`
  and checked every `_test.go` for assertions that exercise the
  stale-version branch in `LastHash` / `LastImportSkip`.
- Confirmed `t.TempDir()` is used universally for filesystem fixtures
  (no leftover artifacts), and `t.Setenv("PROSA_HOME", …)` is used
  in every importer test to keep the raw-tree write inside the
  tempdir.
- Spot-checked `httptest` usage in panel
  (`internal/panel/handlers_auth_test.go:50` constructs a real
  `httptest.NewServer`) and confirmed it does *not* exist on the
  server side.
- Confirmed `just test`, `just test-race`, `just cover` all work as
  advertised (the file is `.justfile`, not `justfile`).
- Confirmed there are no `testdata/` directories anywhere in the
  tree (every fixture is built inline from `t.TempDir()`).

## Recommendations

In rough order of how much real-world risk they buy down:

1. **Fix the SkipCache false-positive class (Finding 1).** Promote
   hermes' `inMemSink` round-trippable implementation to a shared
   `internal/importers/importertest` helper, switch the other five
   importers' tests to use it, and add explicit assertions that the
   no_usage skip persists across a second `Import` call (and that
   `--overwrite` bypasses it). This eliminates the family of bug that
   114f89a fixed for one importer in five other importers.

2. **Add an FK-on assertion (Finding 8).** Three lines in
   `internal/store/store_test.go`: insert a row in `sync_state` with
   a bogus `session_id`, require an error. This locks in the
   `_pragma=foreign_keys(ON)` setting that 114f89a relied on.

3. **Test projection-version reprojection (Finding 2).** Two tests
   for `LastHash` and `LastImportSkip`: store a row at
   `ProjectionVersion - 1`, assert `found == false`. Pin the
   re-projection semantics so a bump doesn't silently fail to
   trigger re-imports.

4. **Anchor the Postgres auth test to real migrations (Finding 3).**
   Replace the inline schema with `migrations/server` `embed.FS`
   replay. Doubles as the only migration-chain smoke test in CI.

5. **Add a `testintegration` build tag and a `just test-integration`
   target that runs Postgres via Docker (Findings 5, 12).** Even a
   single end-to-end "spin up server, push a session, fetch it back"
   would close a wide gap.

6. **Migration up/down identity tests (Finding 6).** For each pair,
   apply up, snapshot the schema, apply down, apply up again, assert
   the snapshot is unchanged. Drop the asymmetric-migration risk to
   zero for the cost of a few hundred lines.

7. **A fuzz target per parser (Finding 13).** `go test -fuzz` for
   30 seconds on every PR; six small files, six small wins.

8. **Inject time via a swappable `nowFn` (Finding 7).** Reduces flake
   surface and makes "since N days" semantics testable without
   sleeping.

9. **Promote `inMemSink` to a shared helper (Finding 11).** Cleanup,
   not a bug-finder, but it makes Finding 1's fix the natural shape.

10. **Run more tests in parallel (Finding 10).** Faster CI, more
    aggressive shake-out of latent races.
