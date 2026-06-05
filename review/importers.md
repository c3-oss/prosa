# Review: Importers (Consistency, Duplication, Edge Cases)

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: 6 importers under internal/importers/, the Sink contract, importpolicy, source docs

## Inventory

| Agent | Package | Source shape(s) | Sink writes per Import | UsageState path |
| --- | --- | --- | --- | --- |
| `claude-code` | `internal/importers/claudecode` | `<root>/<project>/<uuid>.jsonl` + `<parent>/subagents/agent-<uuid>.jsonl` | one session | observe per-line `usage` block; classify Present/ExplicitZero/Unknown |
| `codex` | `internal/importers/codex` | `<root>/<YYYY>/<MM>/<DD>/rollout-*.jsonl` (envelope or legacy) | one session | `event_msg.token_count` event presence + values |
| `cursor` | `internal/importers/cursor` | `<root>/<workspace>/<agent>/store.db` (SQLite) | one session | always Unknown (no usage in source) |
| `gemini` | `internal/importers/gemini` | `<root>/<projhash>/chats/session-*.json` (envelope) or `<root>/<projhash>/logs.json` (live array) | one session per file (largest group when multiple ids in logs.json) | per-`gemini`-record `tokens` block |
| `antigravity` | `internal/importers/antigravity` | `<root>/<cascade-uuid>.db` (SQLite + protobuf blobs) | one session | per-step metadata field 9 protobuf usage decode |
| `hermes` | `internal/importers/hermes` | `<root>/state.db` (multi-session SQLite) + `<root>/sessions/<id>.jsonl` + `<root>/sessions/session_<id>.json` | one session per JSONL/JSON; **many sessions per state.db**; defers to sibling | `messages.token_count` (SUM > 0) |

## Summary

Overall posture: the six importers are tighter than they look at a glance.
The hot path (hash → peek id → idempotency short-circuit → parse → classify
→ preserve raw → projectid.Apply → sink writes) is structurally identical in
the five file-shape importers and is reproduced inside every branch of the
hermes dispatcher. `importpolicy.ClassifyForImport` and
`importpolicy.RecordNoUsageSkip` are used symmetrically; the `Overwrite`
flag is honored everywhere. Tri-state usage classification (v6) is wired
through cleanly.

**Biggest divergence**: hermes alone is multi-shape, multi-session, and
sibling-aware, which makes its idempotency ladder unique. It is also the
only importer that needs a `SkipCache`-implementing fake to test its
file-level marker — and indeed it is the only test fake that implements
`SkipCache`, so cross-importer regressions in the no_usage skip cache are
silently uncovered for the other five. The recent fix `114f89a` (moving
the synthetic `hermes-state-<hash[:12]>` marker out of `sync_state` and
into `import_skips`) is correct and the right shape; it exposes how
fragile the file-level marker abstraction is when extended to other
"multi-session per source" formats.

**Biggest duplication**: every importer has its own `hashAndSize`,
`preserveRaw`, `parseTimestamp`/`parseTimestampString`, scanner buffer
constants, and (in the four importers that touch SQLite) `openReadOnly`.
The `extractText`/`extractContent` helpers are also rewritten in each
package, with subtle differences in what content shapes they accept. The
`Import` method body itself is ~50 lines of near-identical glue
(`claudecode.go:46-112`, `codex.go:45-111`, `cursor.go:49-115`,
`gemini.go:49-115`, `antigravity.go:46-112`, and hermes' three branches)
that would benefit from a shared helper.

**Consistency rating**: medium-high. There are real divergences (kind
tagging, parent-session handling, sibling-wins, SkipCache test coverage)
and one latent footgun (state.db raw-hash semantics under projection
bumps). None of them are data-corruption bugs, but several deserve a
fix.

## Findings

### F1. (medium) Hermes state.db never carries `parent_session_id` despite source having it

Per `docs/sources/hermes.md:48` ("Parent session | `sessions.parent_session_id`
(SQLite only; not projected)") and confirmed at `internal/importers/hermes/parse.go:341`:

```go
rows, err := db.QueryContext(ctx,
    `SELECT id, model, started_at, message_count FROM sessions ORDER BY started_at`)
```

The column is never selected. Codex (`codex/parse.go:254-260`) and
Claude Code (`claudecode/walk.go:77-89`) both populate
`Session.ParentSessionID` from the source — that's the v8 contract
described in `pkg/session/types.go:75-76` and `types.go:99-105`. Hermes
is the agent most likely to spawn subagents (its purpose), so leaving
parents unprojected materially hurts the panel's subagent expansion.

Three concrete asks:
- Add `parent_session_id` to the state.db SELECT, surface it on
  `stateDBRow`, and copy into `sess.ParentSessionID` after projection.
- Add a `parent_session_id` field to the snapshot envelope and JSONL
  message shape in `parse.go::snapshotEnvelope` (line 45) — if Hermes
  preserves it across formats it should round-trip.
- Bump `ProjectionVersion` to 9 when this lands so existing rows
  re-import and pick up the edge.

### F2. (medium) Only `hermes/importer_test.go` implements `SkipCache`; the other five test fakes silently bypass it

`pkg/importer/importer.go:84-87` defines `SkipCache` as an optional
extension. `internal/importers/importpolicy/policy.go:10-23` routes
through `importer.PreviouslySkipped` / `RecordSkip`, both of which do a
type assertion and return `(false, nil)` / `nil` when the sink does not
implement the interface.

Test sinks that do *not* implement SkipCache:
- `claudecode/importer_test.go:23-37`
- `codex/importer_test.go:29-43`
- `cursor/importer_test.go:26-40`
- `gemini/importer_test.go:22-36`
- `antigravity/importer_test.go:27-41`

Only `hermes/importer_test.go:31-88` implements it, and the commit
message of `114f89a` is explicit that "without it the second-Import
idempotency assertion would silently regress."

Consequence: tests like `claudecode/importer_test.go:387`
(`TestImportSkipsSessionWithExplicitZeroUsage`) only verify that the
first import skips. They do not — and cannot — verify the second
import also skips, because `RecordSkip` no-ops on the bare sink. The
production store *does* implement SkipCache (`internal/store/sync_state.go:54-88`),
so this is purely a test-coverage gap, but it is the exact regression
shape `114f89a` warns about.

Fix: move the in-memory sink fake into a shared test helper (e.g.
`internal/importers/internal/testsink/`) that always implements
`SkipCache`, and have every importer's test consume it. Removes ~250
lines of duplication and prevents drift in the test contract.

### F3. (medium) `hashAndSize`, `preserveRaw`, scanner constants, `parseTimestamp`, `openReadOnly` duplicated across importers

Exact-or-near-exact duplicates:

- `hashAndSize`: `claudecode/parse.go:92`, `codex/parse.go:137`,
  `cursor/parse.go:57`, `gemini/parse.go:57`, `antigravity/parse.go:38`,
  `hermes/parse.go:70`. Same body in every file.
- `preserveRaw`: `claudecode/raw.go`, `codex/raw.go`, `cursor/raw.go`,
  `gemini/raw.go`, `antigravity/raw.go`. Hermes
  (`hermes/raw.go:21-63`) takes an extra `ext` argument because of the
  multi-shape situation but is otherwise identical. The only real
  per-importer variation is the extension (`.jsonl`, `.json`, `.db`).
- `parseTimestamp`: `claudecode/parse.go:346`, `codex/parse.go:680`,
  `gemini/parse.go:367`, `hermes/parse.go::parseTimestampString:310`.
  All three: RFC3339Nano → RFC3339, UTC normalized.
- `scanBufferMax = 16 << 20`, `scanBufferInitial = 64 << 10`,
  `firstPromptMaxRunes = 200`: defined twice in claudecode/codex
  (`claudecode/parse.go:30-39`, `codex/parse.go:28-31`), and the rune
  cap is repeated in cursor/gemini/antigravity/hermes parse files.
- `toolPreviewMaxBytes = 4096`, `toolPreviewMaxLines = 40`,
  `truncatePreview`, `truncateUTF8`: identical in `claudecode/parse.go:558-591`
  and `codex/parse.go:570-603`. Antigravity does its own thing.
- `openReadOnly` (read-only SQLite DSN builder): identical text in
  `cursor/parse.go:328`, `hermes/parse.go:326`, `antigravity/parse.go:55`.

Proposal: create `internal/importers/importerutil/` with:

```go
func HashAndSize(path string) (string, int64, error)
func PreserveRaw(agent, sessionID, ext string, startedAt time.Time, src string) (string, error)
func ParseRFC3339(s string) (time.Time, bool)
const ScanBufferMax       = 16 << 20
const ScanBufferInitial   = 64 << 10
const FirstPromptMaxRunes = 200
const ToolPreviewMaxBytes = 4096
const ToolPreviewMaxLines = 40
func TruncatePreview(s string) string
func OpenSQLiteReadOnly(path string) (*sql.DB, error)
```

This pulls roughly 200-300 lines out of the per-importer files without
losing any meaningful per-agent variation. The `extract*` text helpers
are too shape-specific to share (claude's `content[].type=="text"`
filter is not the same as cursor's `type:"text"` filter), so those
stay inline. Same for the `peekSessionID` family — every importer's
header probe is genuinely different.

### F4. (medium) The `Import` method body is ~50 lines of near-identical glue, with one importer-specific divergence per call site

The five single-shape importers all have a body that looks like:

```go
hash, size, err := hashAndSize(path)
sessionID, err := peekSessionID(path)
if !opts.Overwrite {
    if prev, found, err := sink.LastHash(...); ... { return Skipped{}, nil }
    if res, ok, err := importpolicy.PreviouslySkippedNoUsage(...); ... { return res, nil }
}
sess, turns, tools, state, err := parseSession(...)
if sess.ID == "" { sess.ID = sessionID }
sess.Agent = Name
sess.DeviceID = device.IDOnce()
sess.RawHash = hash
sess.RawSize = size
if importpolicy.ClassifyForImport(state) == importpolicy.DecisionSkipNoUsage {
    return importpolicy.RecordNoUsageSkip(...)
}
rawPath, err := preserveRaw(path, sess.ID, sess.StartedAt)
sess.RawPath = rawPath
projectid.Apply(&sess)
sink.UpsertSession(...); sink.InsertTurns(...); sink.RecordSync(...)
```

That's `claudecode/importer.go:46-112`, `codex/importer.go:45-111`,
`cursor/importer.go:49-115`, `gemini/importer.go:49-115`,
`antigravity/importer.go:46-112`, and twice more inside hermes
(`hermes/importer.go:71-134`, `hermes/importer.go:138-204`). The
per-importer deltas are tiny: claudecode/codex pass `sess.StartedAt`
to `preserveRaw`; cursor/gemini/hermes do too; antigravity is the
same. The only material divergence is hermes' `preserveRaw` signature
(extra `ext` parameter — F3 covers fixing that).

Proposal: introduce a `Pipeline` helper in `pkg/importer/pipeline.go`
or `internal/importers/importerutil/pipeline.go`:

```go
type ParseFunc func(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error)

func RunSingleFile(ctx context.Context, agent string, ext string,
    path string, sink Sink, opts ImportOptions,
    peekID func(string) (string, error),
    parse ParseFunc) (ImportResult, error) { ... }
```

Each importer's `Import` shrinks to a one-liner dispatch into
`importerutil.RunSingleFile(..., peekSessionID, parseSession)`. Cuts
~300 lines, makes the contract self-documenting, and prevents the
exact "I forgot to honor opts.Overwrite for this branch" bug class
(which `114f89a` is one step removed from).

Hermes' `importStateDB` stays bespoke because it really is a different
shape — but it can still call `RunSingleFile`-style helpers inside its
per-row loop once the helper exists.

### F5. (low) Cursor's tool-call accumulation runs on every blob but tool *results* are never projected as Turns

Cursor's `parse.go:194-197` accumulates `toolCounts` from
`type:"tool-call"` content items but never appends a `Role:"tool",
Kind:KindToolResult` turn the way claude/codex/antigravity do. The
canonical `session.Turn` doc (`pkg/session/types.go:182-186`)
explicitly leaves room for tool turns, and the panel renders them
specially.

The format-level justification is that Cursor's `tool-call` content
item carries only the request, not the result (results live elsewhere
and are not extracted by this parser). So projecting a tool *Turn*
from a `tool-call` block would be a request, not a result. That's
defensible — the same logic applies to hermes' `tool_calls` JSON
arrays, which also lack the matching result body.

But the divergence should be either documented (one-line note in
`cursor/parse.go` near line 194 saying "tool *results* are not
projected because the cursor store doesn't carry them inline") or
fixed by projecting the request as an "operational" Turn the way
hermes implicitly does by ignoring them.

### F6. (low) Three importers leave `Turn.Kind` empty for chat content; the others set it explicitly

`pkg/session/types.go:108-110` says "Empty Kind is treated as
KindMessage so older rows and zero-value test fixtures keep working
without backfill." That keeps things working but masks drift.

Explicit `Kind: session.KindMessage` on user/assistant turns:
- `claudecode/parse.go:212, 234`
- `codex/parse.go:425, 430, 496, 501`
- `antigravity/parse.go:246, 255, 279`

Empty Kind (relies on store fallback):
- `cursor/parse.go:216, 218`
- `gemini/parse.go:204, 294`
- `hermes/parse.go:217, 219`

Consistency rating: easy fix, low risk. Tag every Turn explicitly so
search/filter callers can rely on `Kind != ""` to mean "importer was
v3-aware." This is also the cleanest place to add `KindOperational`
later if any importer wants to surface system/tool-request blocks.

### F7. (low) Cursor uses `err == sql.ErrNoRows` while antigravity uses `errors.Is(err, sql.ErrNoRows)`

`cursor/parse.go:96`:

```go
if err == sql.ErrNoRows || isMissingTable(err) {
```

`antigravity/parse.go:99, 112`:

```go
if !errors.Is(err, sql.ErrNoRows) {
```

`database/sql` returns the sentinel un-wrapped in current code, so
both work, but `errors.Is` is the idiomatic form (and the form that
survives a future wrapping). Cursor's bare-equality predates the
guideline in `AGENTS.md` § Conventions ("Error wrapping with
fmt.Errorf("...: %w", err). No pkg/errors-style ladders.") which
implies `errors.Is` everywhere it's needed.

### F8. (low) `isMissingTable` lives only in cursor but conceptually applies to hermes' state.db and antigravity's .db too

`cursor/parse.go:387-389`:

```go
func isMissingTable(err error) bool {
    return err != nil && strings.Contains(err.Error(), "no such table")
}
```

Cursor races against Cursor's own bootstrap (file created before
`CREATE TABLE meta`) and needs this. Antigravity could plausibly race
against `agy`'s first write (the `Walk` filter at
`antigravity/walk.go:38` does skip empty files but a SQLite shell
with no `trajectory_meta` table is bigger than zero bytes). Hermes
state.db is created by `hermes` itself so the race is less likely,
but the column probe at `hermes/parse.go:471-494`
(`tableHasColumn`) does open the DB and run `PRAGMA table_info(...)`
which would tolerate any missing-table scenario gracefully.

If `isMissingTable` is the right pattern, it deserves to live in the
shared utility from F3 next to `OpenSQLiteReadOnly`. If it isn't,
cursor's behavior should match what hermes/antigravity do (return an
empty zero-value session without raising the error).

### F9. (low) Symlink handling is implicit and not tested

All importers use `filepath.WalkDir` (except hermes/cursor's flat
`os.ReadDir`). `WalkDir` follows directory entries lazily through
`fs.DirEntry.IsDir()`, which is based on the dirent's type — and
crucially, it does *not* follow symlinks transparently the way
`filepath.Walk` does. So a symlinked directory inside
`~/.claude/projects/` will be skipped by claudecode's walker, and a
symlinked `.jsonl` will be visited and treated as a regular file.

This is probably fine for the live importers (agents don't typically
create symlinks), but the legacy bundle path threads through the same
importers via `internal/cli/sync.go:170-192`, and bundles might
contain symlinks (especially user-curated archives). No test covers
symlinks anywhere in `internal/importers/`.

Suggest: either add a comment "symlinked files are visited as regular
files; symlinked directories are skipped (intentional, matches
filepath.WalkDir semantics)" near each Walk implementation, or add
one shared test that walks a layout with one of each.

### F10. (low) Hermes raw-hash semantics couple every state.db session to the same hash

`hermes/importer.go:267-268`:

```go
sess.RawHash = hash
sess.RawSize = size
```

— where `hash` is `hashAndSize(state.db)`. So every session row
imported out of `state.db` carries the same hash in `sync_state`.
That's documented in `docs/sources/hermes.md:262-267` ("the same file
hash applies to every session row in the DB — any change to the
database causes every session inside to re-parse and re-upsert. This
is correct ... and only slightly wasteful").

The wasteful part is fine. The concerning part is interaction with
the `siblingHasMore` rule (`hermes/parse.go:518-532`): when state.db
projects session `S` (no sibling at that moment), `sync_state["S"]
= hash(state.db@v1)`. The user later creates `S.jsonl`. On the next
sync:
1. state.db hash unchanged → `state_seen` marker fires → state.db
   loop is skipped wholesale.
2. `S.jsonl` is visited by Walk → `importJSONL` runs → it asks
   `sink.LastHash("S")` which returns `hash(state.db@v1)` ≠
   `hash(S.jsonl)` → re-parse fires. Correct outcome.

Now invert: state.db changes (different hash) for an unrelated reason
but session `S`'s message_count is now lower than the sibling
`S.jsonl`'s line count (user touched the sibling). state.db loop
runs, `siblingHasMore` returns true, `S` is skipped inside the
state.db loop. `state_seen` marker is recorded for the new state.db
hash. Then `S.jsonl` is visited → `LastHash("S")` returns the old
`hash(state.db@v1)` from the *original* import → still ≠
`hash(S.jsonl)` → re-parse fires. Fine.

But: when `S.jsonl` does re-parse, its `sess.RawHash` becomes
`hash(S.jsonl)`. Next sync, if state.db has another unrelated change
but the state.db still has more `S` messages than the (now untouched)
sibling, `siblingHasMore` returns false → state.db loop runs `S`
again → writes `sess.RawHash = hash(state.db@v2)`. The session has
oscillated.

This is "only slightly wasteful" per the doc, and the projection
itself is identical, but it does mean `sync_state.last_hash` is not
the useful "identity" you'd expect — it conflates two different
sources. If the server-side reconcile in
`internal/cli/sync_reconcile.go:65` ever uses `last_hash` for
authoritative dedup (it currently uses `RawHash` from the projection
response and the projection version), this becomes a problem.

Fix is non-trivial and probably out of scope for now. The
recommendation is to add a comment to `hermes/importer.go:267` noting
that `sess.RawHash` is the *containing* file's hash, not a
session-specific one, and to verify the server-side reconcile never
treats `sync_state.last_hash` as "this session's content fingerprint."

### F11. (nit) `ImportResult.RawPath` is empty when skipped, but populated *and* `Skipped:true` when state.db's per-session loop completes without writing anything

`hermes/importer.go:296-301`:

```go
return importer.ImportResult{
    SessionID: synthetic,
    RawHash:   hash,
    RawSize:   size,
    Skipped:   false,
}, nil
```

When state.db has only no_usage sessions (or only sibling-deferred
sessions), `imported == 0` but `Skipped:false` is returned (line 296)
unless `noUsageSkipped > 0` (line 292). The CLI's progress accounting
in `internal/cli/sync.go::syncCounts.record` treats `Skipped:false`
as "we did work." For the `imported == 0 && noUsageSkipped == 0`
case (all sessions had siblings), the user sees the state.db marked
as "imported" with no `RawPath` set, no session written, no skip
reason. That's confusing for the operator and inconsistent with the
no_usage branch which does set `Skipped:true`.

Suggest: if `imported == 0 && noUsageSkipped == 0 && siblingDeferred > 0`,
return `Skipped:true, SkipReason: "state_deferred"` (a new constant),
or at least add a comment explaining the asymmetry.

### F12. (nit) `peekSessionID` falls back to filename in every importer but each does it slightly differently

- `claudecode/parse.go:131`: `strings.TrimSuffix(filepath.Base(path), ".jsonl")`
- `codex/parse.go:180-185`: TrimSuffix + UUID-suffix regex (different)
- `cursor/parse.go:80`: `filepath.Base(filepath.Dir(path))` (parent dir, not filename)
- `gemini/parse.go:85`: TrimSuffix
- `antigravity/parse.go:68`: TrimSuffix
- `hermes/importer.go:77` (jsonl path): `stripExt(filepath.Base(path))`
- `hermes/parse.go:97-98` (snapshot path): TrimSuffix `.json` then TrimPrefix `session_`

Two helpers (`stripExt` in hermes, ad-hoc TrimSuffix everywhere else)
could become one. The cursor branch is genuinely different (parent
directory, not filename) and stays inline. Pulling
`internal/importers/importerutil.StripExt(name string) string` out
removes another small redundancy and gives the cursor branch a place
to declare "we use parent dir on purpose" via a `// nolint` style
comment if desired.

### F13. (nit) Codex `tools` slice is built non-deterministically; antigravity sorts; the others don't

`antigravity/parse.go:288-292`:

```go
tools = make([]session.ToolUsage, 0, len(toolCounts))
for name, count := range toolCounts {
    tools = append(tools, session.ToolUsage{Name: name, Count: count})
}
sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
```

Every other importer does the same loop but does not sort:
`claudecode/parse.go:268-271`, `codex/parse.go:345-348`,
`cursor/parse.go:260-263`, `gemini/parse.go:207-210`,
`hermes/parse.go:228-231`. Map iteration in Go is randomized, so the
order written to `session_tools` rows is random per run. The
panel/store may or may not care (the panel typically sorts by count
desc), but tests like `claudecode/importer_test.go:220-227` defensively
build a `map[string]int` to compare counts — i.e., they *know* the
order isn't stable.

Either sort everywhere (1 line per file) and let tests rely on
ordering, or document that `ToolUsage` slices are unordered. The
mixed state is the bug.

### F14. (nit) Per-source docs vs implementation: largely faithful, one drift

Light check only — the dedicated docs reviewer covers this. The
two spots I noticed:

- `docs/architecture/importers.md:35-43` ("Cut 1" "Cut 2" "Cut 3"
  cut-numbering text in package doc comments at
  `claudecode/importer.go:26`, `codex/importer.go:27`,
  `cursor/importer.go:23`) reads like internal phasing that no
  longer matches what's shipped. Cleanup nit.
- `docs/sources/hermes.md:48` still says
  "`sessions.parent_session_id` (SQLite only; not projected)" —
  consistent with F1 above. The doc faithfully reports the gap;
  it's the implementation that needs to catch up.

## What I checked

- `pkg/importer/importer.go` — the contract surface (Sink, SkipCache,
  ImportResult, SkipReason constants).
- `docs/architecture/importers.md` — canonical flow.
- `internal/importers/importpolicy/policy.go` — Classify + RecordNoUsageSkip + PreviouslySkippedNoUsage.
- Every `*/importer.go` (6 files): control flow, opts.Overwrite handling,
  hash/peek/skip ordering, error wrapping conventions.
- Every `*/parse.go` (6 files): UsageState classification, first-prompt
  sanitization, tool counting, timestamp parsing, content extraction,
  Turn Kind tagging, scan buffer sizes.
- Every `*/walk.go` or `*/discover.go` (6 files): root filtering,
  symlink behavior, context cancellation, missing-root handling.
- Every `*/raw.go` (5 files plus hermes' variant): preserveRaw shape,
  collision handling, atomic write semantics, month sharding.
- Every `*/importer_test.go` (6 files): coverage shape, inMemSink
  shape, SkipCache implementation, Overwrite test coverage.
- `internal/store/sync_state.go` — production Sink + SkipCache
  implementation, projection-version handling.
- `pkg/session/types.go` — canonical types, ProjectionVersion = 8,
  Turn.Kind contract, UsageState definitions.
- `internal/cli/sync.go:141-148` — importer registration order.
- Recent fix `114f89a` for the FK-violation root cause.
- `docs/sources/hermes.md` — sibling-wins rule documentation.

## Recommendations

Ordered by impact / effort ratio:

1. **Extract `internal/importers/importerutil/`** with `HashAndSize`,
   `PreserveRaw`, `ParseRFC3339`, `OpenSQLiteReadOnly`,
   `TruncatePreview`, `StripExt`, plus the four shared constants
   (F3, F12). Cuts ~200 lines and stops drift dead.

2. **Extract `Pipeline.RunSingleFile`** for the five single-shape
   importers and the two file-shape hermes branches (F4). Reduces
   `Import` to dispatch, makes the contract self-evident.

3. **Move the in-memory sink fake into a shared `testsink` helper
   that always implements SkipCache** (F2). Prevents the silent
   regression class that `114f89a` had to backfill.

4. **Add `parent_session_id` projection to hermes** for all three
   shapes; bump `ProjectionVersion` to 9 (F1). The bigger product
   improvement on this list.

5. **Tag every chat Turn with `KindMessage` explicitly** in cursor,
   gemini, hermes (F6). One-line change per importer.

6. **Sort `tools` slices in every parser** or document the ordering
   contract (F13). One-line change per importer.

7. **Standardize on `errors.Is(err, sql.ErrNoRows)`** (F7). One-line
   change in cursor.

8. **Fix the asymmetric `Skipped` return** when hermes state.db
   projects nothing (F11). Either add a `state_deferred` skip
   reason or comment the divergence.

9. **Add cursor-specific tool-call documentation** (F5) explaining
   why request blocks are counted but not projected as Turns.

10. **Add a comment to `hermes/importer.go:267`** about `sess.RawHash`
    being the containing file's hash, not a per-session fingerprint,
    and verify the server-side reconcile never treats
    `sync_state.last_hash` as an authoritative identity (F10).

None of these are blocking, but (1)-(4) are the ones that materially
move the codebase forward; they're also the ones that catch the next
"silently broke idempotency" bug before it ships.
