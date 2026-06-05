# Review: Go Idioms & Code Quality

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: Cross-cutting Go quality (error handling, context, concurrency, deps, lint hygiene)

## Summary

prosa is a careful, idiomatic Go codebase. The posture in INTENT.md ("Lean >
complete", "Standard library first", "No error boilerplate") is visible
throughout: `fmt.Errorf("…: %w", err)` is the dominant wrapping style (260
sites), `log/slog` is used consistently for diagnostic logging while
`fmt.Fprintln(os.Stdout, …)` carries user-facing CLI output, generics are
absent in business code (one stdlib generic via `protowire`), `interface{}` is
not used (every `any` is fresh), `go vet ./...` is clean, and there are zero
`//nolint` directives suppressing real signal. The `internal/` vs `pkg/` split
is defensible — only `pkg/session`, `pkg/importer`, and `pkg/httpserver` are
exported, all of which are genuinely consumed (importer adapters, downstream
session shape, and a tiny stdlib `http.Server` wrapper with graceful shutdown).
The dependency footprint is small for a project of this surface area: 13
direct deps, none gratuitous, with `pgx`, `minio-go`, `cobra`, `connect`,
`bubbletea`, `lipgloss`, `testify`, `modernc.org/sqlite`, `goldmark`, and
`klauspost/compress` each carrying their weight.

The weakest area is **concurrency hygiene at process boundaries** —
specifically `internal/cli/sync.go`'s `slog.SetDefault` swap (process-wide
mutation while a background goroutine is running) and `internal/server/handlers/sse.go`'s
goroutine + channel choreography (a goroutine that buffers one error and uses
an unbuffered events channel, with a few mildly confused failure paths).
Neither is critical today — they survive the realistic invocation patterns —
but both are subtle enough to bite a future maintainer.

The headline finding is the **inconsistent `errors.Is` usage**: two call sites
(`handlers/auth.go:110`, `importers/cursor/parse.go:96`) compare sentinel
errors with `==` instead of `errors.Is`. Both happen to work today because
neither error gets wrapped on the way out of pgx/sql, but the moment a
middleware grows or someone wraps the error to add context, the comparison
silently breaks and the handler returns Unauthenticated/Internal instead of
NotFound. This is a low-effort fix that should land before either path grows
any complication.

## Findings

### `err == pgx.ErrNoRows` / `err == sql.ErrNoRows` bypass `errors.Is` — high

**Location:** `internal/server/handlers/auth.go:110`, `internal/importers/cursor/parse.go:96`

Two call sites compare sentinel errors by `==` instead of `errors.Is`:

```go
// handlers/auth.go
if err != nil {
    if err == pgx.ErrNoRows {
        return nil, connect.NewError(connect.CodeUnauthenticated, missingFields("device row"))
    }
    return nil, connect.NewError(connect.CodeInternal, err)
}

// importers/cursor/parse.go
if err == sql.ErrNoRows || isMissingTable(err) {
    return cursorMeta{}, nil
}
```

The rest of the codebase (33 occurrences of `errors.Is`) uses the correct
form, including the very next functions in the same `auth.go` file
(`auth/login.go:107,144,204,344` all do `errors.Is(err, pgx.ErrNoRows)`).
Today these work because the pgx/sql layers don't wrap, but the moment
someone interposes `fmt.Errorf("…: %w", err)` anywhere in the chain, both
checks silently fail closed.

**Suggested fix:** Replace both with `errors.Is(err, pgx.ErrNoRows)` /
`errors.Is(err, sql.ErrNoRows)`. Two-line change, zero behavior delta today,
buys correctness against future wrapping.

### Process-wide `slog.SetDefault` mutated mid-run with concurrent goroutine — high

**Location:** `internal/cli/sync.go:480-482`

```go
prevLog := slog.Default()
slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
defer slog.SetDefault(prevLog)

go func() {
    // …
    rc, reconcileErr = reconcileWithServer(ctx, push, deviceID, opts, hooks)
    // …
}()
```

The TTY sync path suppresses stderr slog so Bubble Tea repaints don't get
clobbered by `reconcile: catching up` lines. The implementation
`slog.SetDefault` mutates *process-global* state — anything else running in
the process (HTTP clients, libraries that use slog internally, the runtime,
plus the goroutine launched immediately after) silently goes to
`io.Discard`. The `defer` restores it, but only after `spinner.Run` returns,
which is the join point that waits for the goroutine. So in practice it's
bounded, but the technique is fragile: anyone who later adds a goroutine
that outlives `spinner.Run`, or reads `slog.Default()` once into a struct
field, gets the wrong logger.

This is exactly the kind of thing that's easy to break in a future refactor.

**Suggested fix:** Pass an explicit `*slog.Logger` down to the things that
need to log during the TTY run (or set the default *handler* via a per-goroutine
`slog.New(...)`), and stop mutating the package default. Alternatively,
replumb `reconcileWithServer` so it accepts a logger and uses
`logger.InfoContext(...)` instead of the package default — the lockless,
no-globals pattern.

### Custom constant-time string compare instead of `subtle.ConstantTimeCompare` — medium

**Location:** `internal/server/auth/login.go:289-304`

```go
func verifyPKCE(verifier, challenge string) bool {
    h := sha256.Sum256([]byte(verifier))
    computed := base64.RawURLEncoding.EncodeToString(h[:])
    return subtleConstantTimeEqual(computed, challenge)
}

func subtleConstantTimeEqual(a, b string) bool {
    if len(a) != len(b) {
        return false
    }
    var v byte
    for i := 0; i < len(a); i++ {
        v |= a[i] ^ b[i]
    }
    return v == 0
}
```

`crypto/subtle.ConstantTimeCompare` exists and does exactly this. The
codebase already uses it in `internal/server/handlers/sse.go:113,122` and
`internal/server/auth/middleware.go:93`. Hand-rolled cryptographic
primitives are a perpetual liability; even when the implementation is
correct (this one is), it raises the bar for security review every time
someone touches it.

**Suggested fix:** Delete `subtleConstantTimeEqual` and call
`subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1` directly. Saves 12
lines and removes a "is this constant time?" code-review checkbox.

### Duplicate `toLower` instead of `strings.EqualFold` — medium

**Location:** `internal/server/handlers/sse.go:107-135`

The SSE handler's `authorized()` re-implements case-insensitive scheme
matching:

```go
if subtle.ConstantTimeCompare(
    []byte(toLower(auth[:len(prefix)])), []byte(prefix),
) != 1 {
    return false
}
// …
func toLower(s string) string {
    out := make([]byte, len(s))
    for i := 0; i < len(s); i++ {
        c := s[i]
        if c >= 'A' && c <= 'Z' {
            c += 'a' - 'A'
        }
        out[i] = c
    }
    return string(out)
}
```

The sibling middleware (`internal/server/auth/middleware.go:115`) does the
same comparison with `strings.EqualFold(h[:len(prefix)], prefix)` — one
line, no allocation, no custom ASCII-lowercase helper. The
`subtle.ConstantTimeCompare` here is also pointless: the scheme prefix is
public knowledge; only the token after it needs constant-time treatment
(which the next line already does correctly).

**Suggested fix:**

```go
if !strings.EqualFold(auth[:len(prefix)], prefix) {
    return false
}
```

Delete `toLower`. Use the same helper extraction pattern as
`middleware.go:108` (`schemeToken`) — or even better, share the helper
between the SSE handler and middleware.

### Server SSE handler: confused error channel + unbuffered events channel — medium

**Location:** `internal/server/handlers/sse.go:72-102`

```go
events := make(chan string)         // unbuffered
errs := make(chan error, 1)         // buffered

go func() {
    for {
        n, err := conn.Conn().WaitForNotification(ctx)
        if err != nil {
            errs <- err
            return
        }
        select {
        case events <- n.Payload:
        case <-ctx.Done():
            return
        }
    }
}()
```

Two minor concerns:

1. The `events` channel is unbuffered. If the consuming loop is in the
   `heartbeat.C` branch and a notification arrives, the producer parks
   until the next iteration. That's acceptable, but a tiny buffer (`make(chan string, 1)`)
   would smooth bursts without changing semantics.
2. The consumer `case <-errs:` discards the error value. For an HTTP SSE
   stream the user already disconnected by then so logging is the only
   recourse — but currently the error vanishes silently. `slog.Warn("sse:
   wait notification failed", "err", err)` before `return` would help
   diagnose listener leaks.
3. The goroutine sends `n.Payload` (a `string`); when `WaitForNotification`
   returns `nil, nil` (it shouldn't, but pgx has historically had edge
   cases on connection close), the goroutine treats it as a "real"
   notification and pushes empty strings into the event stream.

**Suggested fix:**

```go
events := make(chan string, 1)
// …
case err := <-errs:
    slog.Warn("sse: wait notification failed", "err", err)
    return
```

Optional: guard `if n == nil { continue }` after WaitForNotification.

### `tx, err := tx.PrepareContext` followed by `defer stmt.Close()` — medium

**Location:** `internal/store/sessions.go:103-113`, `internal/store/turns.go:34-41`

Within `UpsertSession` and `InsertTurns`, prepared statements are deferred
to close, but the surrounding transaction also gets a `defer tx.Rollback()`.
The cleanup ordering is fine, but `stmt.Close()` returns an error that
might mask a Commit failure on tx that's already rolled back via the
defer, and the prepared statement is then re-prepared on every call —
SQLite usually optimizes for that, but it's still a measurable cost on
the upsert hot path (every session import).

There's no bug here; this is a "the code could be tighter" note. For a
single-row insert path, using `tx.ExecContext` directly avoids the prepare
overhead entirely.

**Suggested fix:** For the `session_tools` and `turns` inserts (which run
in a small loop, often single-digit rows), drop the `Prepare` and use
`tx.ExecContext` directly. The current pattern only earns its place when
the loop iterates hundreds of times, which is rare for tool counts and
not the common case for turns either (most sessions have under 50).

### `if-else if-else` chain that wants to be a `switch` — low

**Location:** `internal/server/handlers/sessions.go:231-261`

The `orderBy` derivation in `List` is an `if … } else if … } else if … } else if … } else if …`
chain on `sortBy`. The whitelisted set comes from `normalizeListSort`,
so the universe of values is closed, which makes this a textbook
`switch sortBy { … }` candidate. Same handler one function above
(`normalizeListSort`) uses a `switch` correctly.

**Suggested fix:**

```go
switch sortBy {
case "total_tokens":
    orderBy = fmt.Sprintf(...)
case "agent":
    ...
case "project":
    ...
case "device":
    if join == "" {
        join = " LEFT JOIN devices d ON d.id = s.device_id"
    }
    orderBy = ...
default:
    orderBy = fmt.Sprintf("s.started_at %s", sortDir)
}
```

(The current code also has an `else if` rather than an explicit `if sortBy ==
""` for the FTS-rank branch, which is fine but inconsistent.)

### Boilerplate context-fallback `if ctx == nil { ctx = context.Background() }` — low

**Locations:** `internal/cli/sync.go:96-98`, `internal/cli/show.go:62-64`,
`internal/cli/nu.go:29-31`, `internal/cli/analytics.go:56-58`,
`internal/cli/search.go:47-48`, `internal/cli/rpc/client.go:146-152`

Every `runX` cobra entrypoint repeats:

```go
ctx := cmd.Context()
if ctx == nil {
    ctx = context.Background()
}
```

Cobra has set `cmd.Context()` to a non-nil value since v1.0 — the only
way to get a `nil` is to call `Execute(ctx)` without calling
`cmd.SetContext`, which the CLI never does because `Execute()` uses
`cmd.Execute()` (which internally provides `context.Background()`). The
defensive nil-check is dead code masquerading as caution.

Even so, the pattern is centralized in `rpc.ContextOrBackground` — but
only three of the six call sites use it. The other three inline the
check.

**Suggested fix:** Either (a) trust cobra and drop the check everywhere
(my preference — it's dead code), or (b) replace all six inline copies
with `ctx := rpc.ContextOrBackground(cmd.Context())` for uniformity.
Pick one; current state has two flavors of the same idea.

### Two-arg `nullableString` conversion called repeatedly per insert — low

**Location:** `internal/store/sessions.go:528-533`

```go
func nullableString(p *string) any {
    if p == nil {
        return nil
    }
    return *p
}
```

Called 10 times per `UpsertSession`. Each invocation boxes a string into
an `any` (heap allocation on amd64 for non-small strings). The hot path
imports thousands of sessions per `sync` run, so this is ~10k allocations
per sync.

Not a bug; just unhelpful. The handlers/sessions.go file (the Postgres
side) does the same with `nullIfEmpty` (lines 1025-1030).

**Suggested fix:** Use `sql.NullString{String: *p, Valid: true}` typed
field — pgx and modernc.org/sqlite both support it natively without boxing
into `any`. (And drop the helper; the call site reads about the same.)

### Stamp `context.WithValue` keys with package-private types — nit (already correct)

**Location:** `internal/server/auth/middleware.go:13-18` — already does the
right thing with `type ctxKey struct{}` and `type ownerKey struct{}`. Worth
calling out as a positive example because the pattern is easy to get wrong.

### `make(chan spinner.Update, len(work)*2+16)` capacity heuristic — nit

**Location:** `internal/cli/sync.go:476`

The capacity calculation works (one Started + one Result per item, plus
boilerplate), but the `+16` is opaque. Add a comment or use named
constants — `const updatesPerItem = 2; const updateOverhead = 16` — so
someone touching the formula six months from now can verify the
assumption.

### Goroutine in `httpserver.Run` is correct but the channel size invites confusion — nit

**Location:** `pkg/httpserver/httpserver.go:20-30`

```go
errCh := make(chan error, 1)
go func() { errCh <- srv.ListenAndServe() }()

select {
case err := <-errCh:
    if errors.Is(err, http.ErrServerClosed) {
        return nil
    }
    return err
case <-ctx.Done():
}
```

When `ctx.Done()` wins, we never read from `errCh`, but the goroutine
returns either way (because Shutdown causes ListenAndServe to return
`http.ErrServerClosed`). The capacity-1 buffer absorbs that send so the
goroutine doesn't leak. Worth a one-line comment because the pattern is
intentionally subtle.

**Suggested fix:** Add `// errCh is buffered so the ListenAndServe send
doesn't block after Shutdown returns.` above the make.

### `_ = id` discards are clutter — nit

**Locations:** `internal/importers/gemini/parse.go:97`,
`internal/importers/cursor/parse.go:185`, `internal/importers/cursor/proto.go:65`

```go
if id, env, ok := readEnvelopeID(data); ok {
    _ = id // session.ID set from env.SessionID below
    return projectEnvelope(ctx, env)
}
```

The right idiom is `if _, env, ok := readEnvelopeID(data); ok {`. The
explicit assignment + comment exists in three places. (Same pattern in
cursor/parse.go:185 around the `id` from `rows.Scan(&id, &data)` —
there, since `Scan` requires the dest, use `var idDiscarded string;
_ = idDiscarded` is no better; consider scanning into `new(string)` or
just accepting the discard.)

**Suggested fix:** Use `_` in the destructuring at the call site where
possible. The Scan one needs a real variable but doesn't need the
`_ = id` line — Go won't complain about an unused write.

### `if err == nil` after sentinel-handled error — nit

**Location:** `internal/cli/setup.go:194-205`

```go
if existing, err := rpc.LoadAuth(); err == nil {
    if rpc.NormalizeServerURL(existing.Server) == rpc.NormalizeServerURL(server) {
        // fast path
    }
}
```

Reads fine; just calling out the missing case: if `LoadAuth` returns an
auth file pointing at a *different* server, we silently fall through to
the browser dance without telling the user we're swapping their saved
auth target. Probably correct (they did pass `--server`), but a
`slog.Info("setup: swapping auth target", "from", existing.Server, "to", server)`
would help debug "why did setup reauthenticate me?"

## What I checked

- Read in full: `cmd/prosa/main.go`, `cmd/prosa-server/main.go`,
  `cmd/prosa-panel/main.go`, `internal/cli/root.go`, `internal/cli/sync.go`,
  `internal/cli/sync_push.go`, `internal/cli/sync_reconcile.go`,
  `internal/cli/sync_denoise.go`, `internal/cli/login.go`,
  `internal/cli/setup.go`, `internal/cli/show.go`, `internal/cli/search.go`,
  `internal/cli/analytics.go`, `internal/cli/nu.go`, `internal/cli/term.go`,
  `internal/cli/devices.go`, `internal/cli/project.go`,
  `internal/cli/spinner/sync.go`, `internal/cli/rpc/client.go`,
  `internal/cli/schedule/schedule.go`, `internal/cli/schedule/linux.go`,
  `internal/cli/schedule/macos.go`, `internal/store/store.go`,
  `internal/store/sessions.go`, `internal/store/migrations.go`,
  `internal/store/sync_state.go`, `internal/store/devices.go`,
  `internal/store/search.go`, `internal/store/turns.go`,
  `internal/store/backfill.go`, `internal/store/analytics.go` (partial),
  `internal/server/server.go`, `internal/server/config.go`,
  `internal/server/auth/login.go`, `internal/server/auth/middleware.go`,
  `internal/server/handlers/auth.go`, `internal/server/handlers/devices.go`,
  `internal/server/handlers/sessions.go`,
  `internal/server/handlers/sessions_get_raw.go`,
  `internal/server/handlers/sse.go`, `internal/server/handlers/common.go`,
  `internal/server/handlers/analytics.go` (partial),
  `internal/server/storage/pg.go`, `internal/server/storage/objstore.go`,
  `internal/device/fingerprint.go`, `internal/paths/xdg.go`,
  `internal/projectid/projectid.go`, `internal/legacy/bundle.go`,
  `internal/pricing/pricing.go`, `internal/buildinfo/buildinfo.go`,
  `internal/importers/claudecode/importer.go`,
  `internal/importers/cursor/parse.go`, `pkg/session/types.go`,
  `pkg/importer/importer.go`, `pkg/httpserver/httpserver.go`, `go.mod`,
  `.golangci.yml`.
- Searched the tree for: `context.Background`, `log.Printf`/`log.Println`,
  `go func`/`go [Ident](`, `make(chan`, `panic(`, `//nolint`, `_ =` (discard
  patterns), `err == ` (vs `errors.Is`), `interface{}`, `TODO`/`FIXME`/`XXX`,
  `sync.Mutex`/`sync.Once`/`sync.RWMutex`, `slog.SetDefault`,
  `context.TODO`, `WaitForNotification`, third-party deps' import sites.
- Ran `go vet ./...` — clean, exit 0.
- Audited go.mod direct deps and their import sites: every direct dep is used
  in `cmd/`, `internal/`, or `pkg/` and earns its place.
- Counted: 260 `fmt.Errorf("…: %w", …)` sites vs 84 `return err` (most of the
  84 are inside small helpers that already have caller context). Wrapping
  discipline is strong.
- Verified `internal/` vs `pkg/` split: only `pkg/session`, `pkg/importer`,
  `pkg/httpserver` are exported; all three have multiple internal consumers
  and the exporter contract is documented in package doc comments.

## Recommendations

1. **Fix the two `==` comparisons to use `errors.Is`** —
   `handlers/auth.go:110` and `importers/cursor/parse.go:96`. Two-line patch,
   removes a latent bug that becomes a real one as soon as anyone wraps the
   underlying error.
2. **Stop process-wide `slog.SetDefault` in `runSyncInteractive`** — thread
   a `*slog.Logger` through `reconcileWithServer` and the inline driver
   goroutine instead of mutating the global. Keeps the rest of the process
   honest if anyone else logs concurrently with sync.
3. **Drop the hand-rolled `subtleConstantTimeEqual` (auth/login.go) and
   `toLower` (handlers/sse.go)** in favor of `subtle.ConstantTimeCompare` /
   `strings.EqualFold`. The hand-rolled copies are correct, but every
   security review needs to re-verify them; the stdlib equivalents shrink
   that surface to zero.
4. **Tighten SSE goroutine choreography**: buffer `events` (cap 1), log
   the discarded `errs` value with `slog.Warn`, optionally guard
   `n == nil`. The current code works under expected conditions; the
   suggested changes harden it against pgx edge cases without adding
   complexity.
5. **Replace the `if-else if` chain in `sessions.go:231-261` with a
   `switch sortBy`** to bring it in line with the rest of the codebase's
   style and the same handler's own `normalizeListSort`. Cosmetic, but
   makes the closed-set branching visually obvious.

## Out of scope but worth noting

- **`internal/cli/show.go:262` `defer f.Close()` ignores error** — fine for a
  read path on stdout copy, but inconsistent with the rest of the codebase
  which uses `defer func() { _ = f.Close() }()` to make the discard explicit.
  Either harmonize on one form or trust gofumpt to settle the question.
- **`internal/store/sessions.go:103-113` prepared statement in a small
  loop** — for the analytics/projects tables the loop is small enough that
  preparing once doesn't pay for itself. Worth a benchmark before changing,
  but worth noting.
- **`subtle.ConstantTimeCompare` short-circuits on length mismatch** — this
  is a documented behavior and not a real timing leak for token comparison
  (lengths are public knowledge for any sane scheme), but if anyone ever
  starts comparing the actual user-supplied admin token byte-for-byte against
  one that has been truncated/expanded by middleware, the length-leak
  becomes a real-world side channel. Not visible today.
- **`internal/legacy/bundle.go:155` `io.Copy(out, dec)` ignores
  context cancellation mid-decompress** — the package docstring acknowledges
  this. For the legacy bundle path that's fine; just flagging that the
  contract is documented and intentional.
- **`internal/cli/sync.go:451-452` `padSummaryLabel` reinvents
  `fmt.Sprintf("%-9s", label)`** — minor, but the stdlib already pads.
