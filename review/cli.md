# Review: CLI (Commands, Flags, Rendering, UX)

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: cmd/prosa, internal/cli/*

## Command surface

| Command | Purpose | Local flags | Notes |
| --- | --- | --- | --- |
| `prosa` (bare) | Default chronological timeline | `--limit` | Global filter flags + auto project scope |
| `prosa sync` | Walk importers + push to server | `--legacy-bundle`, `--overwrite`, `--verbose` | Bubble Tea TUI in TTY, slog elsewhere |
| `prosa search <q>` | FTS5 query | `--limit` (default 20) | Honors global `--remote` |
| `prosa show <id>` | Render or dump a session | `--raw`, `--remote`, `--max-output-lines` | TTY: rendered, pipe: raw bytes |
| `prosa analytics <report>` | Fixed reports | (none; uses global) | Reports: `sessions`, `tools`, `models`, `projects`, `errors`, `heatmap`, `usage` |
| `prosa login` | PKCE + localhost callback | `--server` | Browser open is best-effort |
| `prosa logout` | Remove auth.json | (none) | |
| `prosa devices [list\|rename\|revoke]` | Manage server-side devices | (varies) | Bare `prosa devices` runs `list` |
| `prosa schedule [install\|uninstall\|status]` | launchd / systemd timer | `--interval` (install) | Bare `prosa schedule` prints help |
| `prosa setup` | First-run wizard | `--server`, `--interval`, `--skip-scan`, `--non-interactive` | Calls login + schedule + sync |

Global persistent flags: `--last`, `--since`, `--between`, `--project`, `--device`, `--agent`, `--all`, `--json`, `--remote`. Root-only (non-persistent): `--limit`.

## Summary

Overall the CLI is well-shaped: Cobra dispatch is tidy, the "one-shot output / TTY vs pipe" posture from `INTENT.md` is mostly honored, scope detection (git remote → marker → path) is genuinely good, and the error UX on parse failures is friendly. The Bubble Tea spinner is also pragmatically scoped (no alt screen, fixed-height frame).

The weakest area is **sync UX consistency under partial failure**: push errors in both phases are silently demoted from rich errors to a generic literal (`errors.New("push failed")` in the catch-up loop) or to a slog line that is suppressed during the interactive run. Combined with Bubble Tea's lack of `WindowSizeMsg` handling, this gives the user truncated, vague error feedback exactly when they need detail.

The biggest inconsistencies are:

1. `--json` is advertised as a global "emit NDJSON instead of human-formatted output" but is honored only by `prosa` (bare), `search`, `analytics`, `show`, and `devices list`. `sync`, `login`, `setup`, `schedule`, `logout`, and `devices rename/revoke` silently ignore it.
2. `--no-color` appears in `docs/architecture/cli.md` but is not registered as a flag anywhere in the code — help text effectively lies.
3. `--remote` is documented as "ignored elsewhere" yet is genuinely re-implemented as a local flag on `show`; users have no signal that `prosa show --remote <id>` is special compared to `prosa --remote ...`.

The data-loss surface is small (push is idempotent by hash; sync is read-mostly) but `--overwrite` is a real footgun: it bypasses idempotency *and* re-pushes every session. The help text is honest about this, but there is no confirmation prompt or dry-run flag.

## Findings

### critical

(none)

The `--overwrite` flag is the closest thing to data-impact in the surface
(`internal/cli/sync.go:60-63`), but it does not mutate raw files, and the push
side accepts duplicates via hash idempotency on the server. Worst case is a
wasted network round-trip per session, not data loss.

### high

**H1 — `prosa sync --json` silently ignores `--json`, breaks the global flag
contract.**
`internal/cli/sync.go:94-237`, `internal/cli/root.go:60`.
The root help advertises `--json emit NDJSON instead of human-formatted
output` as global, but `sync` never checks `g.JSON` and emits slog text on
stderr + a human banner on stdout. Verified locally with `prosa sync --json`
producing standard `time=... level=INFO msg=imported ...` lines. Either honor
`--json` (emit NDJSON per session: `{"agent":"...","session_id":"...",
"status":"imported|skipped|error","push":"...", "err":"..."}`) or make
`--json` non-persistent and document the actual set of commands that support
it.

**H2 — Push errors in the catch-up phase are stripped to the literal `"push
failed"`.**
`internal/cli/sync.go:567-568`.

```go
case pushFailed:
    u.Err = errors.New("push failed")
```

The real error (`fmt.Errorf("push rpc: %w", err)` from `sync_push.go:106`) is
captured by `counts.recordPush` but the spinner's `errors` block only sees
the constant string. If the server returns a useful Connect message
("session 7e3... violates manifest", "raw payload too large", …) the user
sees only `push failed` and has to re-run sync with `--verbose` to recover
the detail. Fix: thread the actual error through `pushSession`'s second
return and pass it into the spinner Update.

**H3 — Push errors during the inline (local-phase) push are never shown in
the interactive UI.**
`internal/cli/sync.go:517-519`.

```go
if push != nil && err == nil && !res.Skipped {
    counts.recordPush(push.pushSession(ctx, res.SessionID))
}
```

Only the importer error is sent into the spinner (`Err: err` on line 524).
If the importer succeeds but the immediate push fails (network blip,
auth-token rotation, server 5xx), the failure is counted in `counts.pushErr`
but the spinner shows the row as a clean `✓`. The summary at the end shows
`Push: sent X · skipped Y · errors N` with no per-session detail. In a
healthy run with one bad session, the user has no way to find it without
re-running `--verbose`. Suggest: surface the first push error per agent in
the spinner's `errors` block, or print the per-session error list under the
summary if `pushErr > 0`.

**H4 — Bubble Tea spinner does not handle `WindowSizeMsg`, so terminal
resize during a long sync silently breaks layout.**
`internal/cli/spinner/sync.go:437-456`.
`tea.NewProgram(m, tea.WithContext(ctx))` never configures resize handling,
and `model.Update` has no `WindowSizeMsg` case. On a multi-minute sync run
across hundreds of sessions, resizing the terminal (which the user might do
because the spinner is wider than 80 cols) leaves error lines truncated at
the original width, and the rail/header glyphs at column boundaries no
longer line up. Compounding this, error messages have no per-line width
budget at all (`internal/cli/spinner/sync.go:308-316` writes the raw
`e.msg`), so any 200-char error like a SQL constraint message gets visually
clipped by Bubble Tea. This is consistent with the user's sample where
`FOREIGN KEY const` is truncated mid-word.

**H5 — Spinner stops responding to update channel after any non-quit key
press.**
`internal/cli/spinner/sync.go:153-246`.

```go
case tea.KeyMsg:
    if v.String() == "ctrl+c" || v.String() == "q" {
        return m, tea.Quit
    }
}
return m, nil
```

The unrecognized-key branch falls through to `return m, nil` *without*
re-scheduling `recvCmd(m.ch)`. Bubble Tea only re-dispatches the channel
read when `recvCmd` returns. After the user presses any key (arrow, space,
modifier), the spinner stops consuming updates and freezes mid-run; the
driver goroutine eventually blocks on the bounded channel buffer
(`make(chan spinner.Update, len(work)*2+16)`) and stalls the whole import.
Fix: every non-quit `tea.Msg` branch should return `tea.Batch(m.spin.Tick,
recvCmd(m.ch))` (or at minimum `recvCmd(m.ch)`).

**H6 — `--all` and `--project` are accepted together silently, with
`--project` winning.**
`internal/cli/nu.go:61-80`, `internal/cli/search.go:82-100`,
`internal/cli/analytics.go:128-145`.

```go
switch {
case g.Project != "":
    ...
case g.All:
    ...
}
```

Verified locally with `prosa --all --project foo` returning no sessions
without warning. INTENT.md `§5` says `--all` overrides cwd auto-detect; the
combination is meaningless and should produce
`error: --all and --project are mutually exclusive` instead of silently
preferring one. The doc comment on `runNu` actually advertises the wrong
precedence too: it says step 2 is "`--all` → auto-detect off", but the
runtime branches `--project` first, so a user who reads the comment expects
`--all --project x` to apply both.

**H7 — `--no-color` is documented but unimplemented.**
`docs/architecture/cli.md:58` lists `--no-color` as a global flag. There is
no `pf.BoolVar` for it in `internal/cli/root.go`, and the codebase grep for
`NoColor`, `no-color`, `NO_COLOR`, `CLICOLOR` returns nothing. Lipgloss
honors `NO_COLOR=1` env transparently as a side benefit, but the documented
flag literally does not exist. Either implement it (set
`lipgloss.SetDefaultRenderer` to a no-style renderer, or thread an
`Interactive=false` decision through every renderer) or delete the doc
entry.

### medium

**M1 — `runDevicesList` is bound as `cmd.RunE` on the parent, but
`schedule` requires an explicit subcommand.**
`internal/cli/devices.go:28-31`, `internal/cli/schedule_cmd.go:17-29`.
`prosa devices` runs `list`; `prosa schedule` prints usage. Pick one
convention. Personally I'd remove the `devices` default — making the user
type `devices list` is a one-time annoyance, and the precedent matches
`schedule`.

**M2 — Scope detection logic is duplicated across four call sites.**
`internal/cli/nu.go:60-80`, `internal/cli/search.go:80-100`,
`internal/cli/analytics.go:128-145` (local + remote variants).
Each rebuilds the same `switch { case g.Project != "": ...; case g.All:
...; default: cwd auto-detect }` block. The local-store branch even opens
the read-only store *just* to drive `DetectProject` in the remote analytics
path (`internal/cli/analytics.go:213-244`). Worth extracting into a single
helper: `func ResolveScope(ctx, g, store) (Match, render.ContextScope,
string)` and let callers convert the Match into either a SessionFilter or a
proto request.

**M3 — `prosa show --raw` works on local only; `--raw --remote` is a
hard error, but the help text doesn't explain why or hint at the
workaround.**
`internal/cli/show.go:68-70`.

```go
if showRawFlag && showRemoteFlag {
    return fmt.Errorf("--raw and --remote are mutually exclusive (raw lives on local disk)")
}
```

But the code path immediately below
(`internal/cli/show.go:99-105`) explicitly invokes `copyRemoteRaw` in the
non-TTY default branch when `--remote` is set, proving the server *can*
stream raw bytes (`streamRemoteRaw` walks the `GetRaw` RPC). The current
behavior is inconsistent: `prosa show <id> --remote | jq` works (gets the
raw), but `prosa show <id> --remote --raw` errors. Either drop the
exclusion check (remote raw works), or document that the non-TTY fallback
is intentionally distinct from explicit `--raw`.

**M4 — `--limit` semantics collide with `prosa search --limit`.**
`internal/cli/root.go:63`, `internal/cli/search.go:40`.
The root `--limit` defaults to 0 (no limit) and applies only to the bare
timeline. Search's local `--limit` defaults to 20. `prosa --limit 5 search
foo` parses (the root flag binds to `g.Limit`) but is ignored because
`runSearch` reads `searchLimit` from the local flag, which stays at its
default of 20. A user who learns `prosa --limit 5` for timeline and tries
the same pattern on search will get surprising results. Either make the
root `--limit` persistent and honored by search (defaulting to 20 when
unset), or rename the search flag to `--max` to remove the collision
incentive.

**M5 — Sync interactive errors lose the importer agent label after spinner
LRU eviction.**
`internal/cli/spinner/sync.go:80, 219-228`.
`maxErrorSlots = 5` is hardcoded, and the trimming
(`m.errs[len(m.errs)-maxErrorSlots:]`) keeps the most recent five. In a
2000-session run where the first cursor import fails, the user sees only
the last five error lines, and the cursor failure scrolls off without
warning. The summary banner reports `errors N` but doesn't enumerate which
agents contributed. Suggest: keep at least one error slot per agent label
that has erred, or print "+K earlier errors hidden" inline so the count
matches what was elided.

**M6 — Sync writes the summary banner to stdout, breaking pipe contract
documented in `docs/architecture/cli.md:76`.**
`internal/cli/sync.go:196, 352-379`.
The contract says "stdout carries only the command's primary result". Sync's
"primary result" is the import — but the summary text
("`prosa sync · complete`", "`Live: imported 44 · skipped 51 …`") is
diagnostic, not data. A user running `prosa sync > /tmp/out.log` for an
upgrade audit gets the banner in their log, which is fine; but `prosa sync
| jq` (which a script might do once `--json` works per H1) chokes. Suggest:
move banner + summary to stderr when not in JSON mode; or accept that sync
has no "primary result" in the data sense and document the exception.

**M7 — `--agent` accepts unknown values silently.**
`internal/cli/root.go:58`.
The help text enumerates `(claude-code | codex | cursor | gemini |
antigravity | hermes)` but `prosa --agent banana` runs without error and
returns zero sessions. With a fixed enum on hand (the importer registry in
`internal/cli/sync.go:141-148` and `internal/cli/setup.go:70-91`), there's
no reason not to validate. Suggest: `cobra.MatchAll(...)` + a `ValidArgs`
on the flag, or a sentinel check in `runNu` that returns
`error: --agent: unknown agent %q; expected one of (claude-code, codex, ...)`.

**M8 — Empty-state messages drop the time window in "project not detected"
mode.**
`internal/cli/render/context.go:95-100`.

```go
if opts.Scope == ScopeProjectNotDetected {
    return "showing all projects"
}
```

When the cwd has no project match, the context line becomes
`prosa · local · project not detected · showing all projects` — the
`--last 7d` segment is replaced, not appended. If a user then runs
`prosa --last 30d` from outside a known project, the context line silently
omits the 30d label and they have no immediate confirmation the window
flag was honored. Suggest: append the window label after the not-detected
hint, e.g. `prosa · local · project not detected · showing all projects ·
last 30d`. The current behavior actively hides information the user
explicitly asked for.

**M9 — Slog suppression during interactive sync is process-global.**
`internal/cli/sync.go:480-482`.

```go
prevLog := slog.Default()
slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
defer slog.SetDefault(prevLog)
```

This drops every slog call across the binary while Bubble Tea is running,
including unrelated warnings (project identity backfill, store warnings,
remote unavailable). It is restored on exit, but during the run any
diagnostic that an importer might emit through slog (e.g. `slog.Warn` in
the legacy bundle decompress path) goes to the void. The user can re-run
with `--verbose` to recover, but a one-line "diagnostic logs suppressed in
TTY; use `--verbose` to see them" hint after the summary would close the
loop. Better still, capture suppressed warnings into an in-memory buffer
and print a `Warnings: N` count under the summary.

### low

**L1 — Duration helpers are duplicated.**
`internal/cli/render/timeline.go:262-275` (`humanDuration`),
`internal/cli/spinner/sync.go:402-417` (`humanDur`),
`internal/panel/render/duration.go:13-42` (`HumanDuration`).
Three subtly different implementations of the same idea. Spinner uses
`1m05s`/`1h02m`; timeline uses `1mins`/`1h02`; panel uses `1m 5s`/`1h 2m`.
Worth lifting into a shared `internal/durfmt` package with one variant per
audience (CLI dense, panel airy) so the next bug fix lands in one place.

**L2 — `internal/cli/render/` and `internal/panel/render/` share a name
but no code.**
The CLI render package handles ANSI/lipgloss output; the panel render
package handles HTML/markdown. Naming overlap suggests they're related;
they aren't. Suggest renaming one (`internal/cli/textrender`,
`internal/panel/htmlrender`) for clarity at import sites.

**L3 — Connect server URL defaulting is silent.**
`internal/cli/rpc/client.go:105-111`.

```go
if !strings.HasPrefix(in, "http://") && !strings.HasPrefix(in, "https://") {
    host := strings.TrimPrefix(in, ":")
    in = "http://localhost:" + host
}
```

`prosa login --server foo.example.com` silently becomes
`http://localhost:foo.example.com` (which fails later in dial), instead of
`https://foo.example.com`. Suggest: if the input parses as a URL with a
host, prepend `https://`; only fall through to the `localhost:port`
expansion when the input matches `^:\d+$`.

**L4 — `panel_time.go`-style time formatting is centralized; CLI is not.**
Several render call sites format time inline with `Format("2006-01-02
15:04")` (`internal/cli/render/show.go:42`,
`internal/cli/render/search.go:127`) and a few with `RFC3339`
(`internal/cli/render/timeline.go:251`). Plain output uses RFC3339 (good
for scripts), but interactive uses `Jan 02 / 15:04`. Worth a
`internal/cli/timefmt` helper for the three or four shapes the renderers
need.

**L5 — `panel_time.go`-style search header omits the time zone.**
`internal/cli/render/search.go:196-199`. Search uses local time labels
("Today 13:42"); timeline (`render/timeline.go:97`) also uses local. INTENT
says day-grained; mixing local and UTC across `--since` (UTC) and the
display column (local) can surprise users near midnight in non-UTC TZ.
Worth a one-liner in the context line: `prosa · local · scoped to prosa ·
last 7d · TZ America/Sao_Paulo` or, less intrusively, render the day
boundary in UTC and let the user discover by reading the docs.

**L6 — `runSync` opens the store with `store.Open` (read/write) even when
no live work is present.**
`internal/cli/sync.go:103-107, 195-198`.
If `len(work) == 0`, the function still upserts the device row (line 121)
and runs the project identity backfill (line 137) before printing
`No sessions found.` and returning. The backfill is idempotent so the user
sees no impact, but for a freshly installed prosa on a machine with no
imports, the device row write is the only state change — and it's hidden.
Cosmetic, but worth a slog line at info: "no live work; device row updated"
to keep the audit trail explicit.

**L7 — `prosa logout` always prints to stdout, regardless of TTY.**
`internal/cli/login.go:180-186`. The friendlier `✓ auth cleared` and the
plain `logged out` differ only by color; the plain mode otherwise lacks the
key=value envelope used by `setup`, `schedule`, `devices`. Inconsistent
with M1 and the wider pattern. Suggest: in non-interactive mode emit
`status\tcleared` to match the rest of the family.

### nit

**N1 — Help for `--remote` says "ignored elsewhere" but it's honored by
`show` via a shadowing local flag.**
`internal/cli/root.go:64`. Either clarify "honored by analytics, search,
show; ignored elsewhere" or unify the flag plumbing.

**N2 — Sync long help describes `--legacy-bundle` in one ~250-word
paragraph.** `internal/cli/sync.go:42-54`. Break this into a `Long:` with
explicit sections (`flags:` / `flow:` / `examples:`); current rendering
is a wall of text.

**N3 — `prosa show` missing arg produces Cobra's default `accepts 1
arg(s), received 0` instead of a contextual `usage: prosa show
<session-id>`.** `internal/cli/show.go:38`. Either add a `SuggestFor`
nudge or implement a custom `Args` checker that hints at how to fetch the
id (`run \`prosa\` to list timeline ids`).

**N4 — Banner string `prosa sync · local store` is hardcoded twice.**
`internal/cli/sync.go:383, 598`. One value, two spellings drift.

**N5 — Help text spans on `prosa setup --server` and `prosa login
--server` differ in tone (setup explains env var default; login does
not).** `internal/cli/setup.go:49-50`, `internal/cli/login.go:168`.
Worth aligning so both surface the same fallback chain
(`flag → $PROSA_SERVER_URL → default`).

**N6 — `prosa schedule install` does not warn if `--interval < 1m`.**
Actually it does (`schedule/macos.go:45`, `schedule/linux.go:47`), but the
error message is `interval too short: 30s (minimum 1m)` — fine. Worth
also adding a soft warning for unreasonably long intervals (e.g. >24h);
a user typing `--interval 1d` may have wanted to write 24h and the
scheduler accepts it without flagging the surprise.

**N7 — The "current" line in the spinner uses `shortPath` truncating from
the left with an `…` prefix.** `internal/cli/spinner/sync.go:422-432`.
On the remote phase, the "path" is a 36-char session UUID, which is
always within the cutoff. But for sessions whose ids are longer (legacy
synthetic ids like `hermes-state-690562151c59`) the result reads
naturally; for normal UUIDs the `…` never appears. Cosmetic but the
prefix logic could short-circuit on session-id-like inputs to avoid the
optical inconsistency between phases.

## What I checked

- Entry point and Cobra topology: `cmd/prosa/main.go`, `internal/cli/root.go`,
  per-command files.
- Command dispatch and global flag binding in `root.go`; verified persistent vs
  local flag boundaries by reading the file and inspecting `prosa --help`,
  `prosa <cmd> --help` for every command.
- Sync flow end-to-end:
  - `runSync` orchestration (`internal/cli/sync.go:94-237`).
  - Push and outcome routing (`internal/cli/sync_push.go`,
    `sync_reconcile.go`).
  - Bubble Tea progress (`internal/cli/spinner/sync.go`) including model,
    update reducer, view, and the `recvCmd` channel pattern.
  - Plain/`--verbose` fallback (`internal/cli/sync.go:635-668`).
  - Denoise pass (`internal/cli/sync_denoise.go`).
- Auto project scoping: `internal/cli/project.go`, including INTENT §5
  precedence (git remote → marker → path).
- Window resolution: `internal/cli/window.go`, `duration.go` and their tests.
- Rendering primitives: `internal/cli/render/styles.go`, `context.go`,
  `timeline.go`, `search.go`, `show.go`, `prompt.go`, `device.go`,
  `cardinality.go`, `analytics.go`, `active.go`, `dayheaders.go`.
- TTY detection: `internal/cli/term.go`.
- Auth + PKCE flow: `internal/cli/login.go`, `setup.go`, `rpc/client.go`,
  `browser/open.go`.
- Schedule install/uninstall/status across macOS + Linux:
  `internal/cli/schedule/*.go`.
- Devices subcommand surface: `internal/cli/devices.go`.
- Cross-checked docs: `INTENT.md`, `docs/cli/screens.md`,
  `docs/cli/rendering-contract.md`, `docs/architecture/cli.md`.
- Built `prosa` and ran a battery of invocations: invalid args, invalid
  durations, mutually exclusive flag combinations, `--json` per command,
  `--all`+`--project`, non-existent agent, schedule status,
  `setup --non-interactive`, logged-out devices list, show missing arg,
  show non-existent id.

I did not deeply audit:

- The render layer's `_test.go` golden output files (I read the timeline,
  search, show, and spinner tests as samples; the rest looked similar in
  structure).
- The legacy bundle ingest path beyond confirming it routes through the same
  spinner channel.
- The analytics heatmap/usage TTY rendering visually (read code only).

## Recommendations

In rough order of impact / effort:

1. **Fix the push-error swallow loop (H2, H3).** This is the single change
   that most directly closes the gap between "the user's sample showed a real
   error" and "the user knows what to do next". The fix is mechanical: pass
   `err` from `pusher.pushSession` into the spinner Update so the UI's error
   block has the actual message.
2. **Add `WindowSizeMsg` handling and a per-line truncation in the spinner
   (H4).** Modest amount of code, large UX payoff. Honor the active width and
   wrap or truncate error strings deliberately instead of letting Bubble Tea
   chop them.
3. **Patch the spinner key-handler regression (H5).** One-line fix; risk of
   freeze in real sessions is real.
4. **Decide on the `--json` contract and make it true (H1).** Either
   implement NDJSON output in sync (one record per importer outcome plus a
   trailing summary record) or drop `--json` from the persistent set and
   document the supporting commands.
5. **Validate flag combinations (H6, M7) at parse time.** Reject
   `--all --project x`; reject unknown `--agent` values. The Cobra
   `RunE` is the right place. Add a small `validateGlobals(cmd)` helper
   called at the top of every `RunE`.
6. **Delete or implement `--no-color` (H7).** If you choose to implement,
   `lipgloss.SetDefaultRenderer(lipgloss.NewRenderer(io.Discard,
   termenv.WithProfile(termenv.Ascii)))` covers most cases.
7. **Extract the scope detection helper (M2).** Replace four 15-line
   switches with one helper; the diff is large but mechanical.
8. **Move sync summary to stderr or honor a stable stdout contract (M6).**
   The decision depends on (4); whichever path you pick, document it.
9. **Tighten the empty-state context line (M8).** Append the window label
   in not-detected mode.
10. **Decide on `devices` vs `schedule` parent-command convention (M1).**
    Pick one; current divergence is small but annoying.
11. **Centralize duration formatting (L1).** Three implementations is two
    too many.

These are listed against the INTENT.md posture: small fixes that make the
central question easier to answer ("what did I work on?" and, inside sync,
"what went wrong with this run?"). None of them require new dependencies;
all are achievable inside the existing module boundaries.
