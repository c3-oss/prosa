# Review: Architecture & Package Boundaries

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: Module layout, internal/pkg boundaries, layering, crossed responsibilities

## Architecture map

```
                       ┌──────────────────────┐
                       │ proto/prosa/v1/      │  ───►  gen/go/prosa/v1/
                       │ (Connect IDL)        │        (committed)
                       └──────────────────────┘
                                  │
                                  │ (imported as both server-side
                                  │  + client-side types)
                                  ▼
        cmd/prosa            cmd/prosa-server          cmd/prosa-panel
            │                      │                        │
            ▼                      ▼                        ▼
   ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
   │ internal/cli   │      │ internal/server│      │ internal/panel │
   └────────────────┘      └────────────────┘      └────────────────┘
       │   │   │  │            │       │              │      │    │
       │   │   │  │            ▼       │              │      │    │
       │   │   │  │      handlers/  storage/          │      │    │
       │   │   │  │           │                       │      │    │
       │   │   │  │           ▼                       │      │    │
       │   │   │  │     (pg + S3 only)                │      │    │
       │   │   │  └────────────────────┐              │      │    │
       │   │   │                       │              │      │    │
       │   │   ▼                       │              ▼      │    ▼
       │   │  internal/cli/rpc ────────┼──── Connect ── internal/panel/rpc
       │   │  (Connect client)         │      RPC          (Connect client)
       │   ▼                           │
       │  internal/store  (SQLite, FTS, projection)
       │   ▲     ▲   ▲                 ▲
       │   │     │   │                 │
       ▼   │     │   │                 │
   internal/importers/<agent>          │
        │     │       │                │
        └─────┴───────┴──── shared ─── ┴────► pkg/session, pkg/importer
                                            internal/sessiontext, /projectid,
                                            /pricing, /device  (BY DESIGN)

   LEAKY EDGES (flagged below):
   * internal/server/handlers/* duplicates analytics SQL with
     internal/store/analytics.go (same query shapes, two SQL dialects).
   * internal/cli/* hardcodes "~/.config/prosa/auth.json" strings in
     login.go and sync_push.go even though paths.AuthPath() exists.
   * Importers re-derive ~/.claude, ~/.codex, ~/.cursor roots with
     os.UserHomeDir() instead of going through internal/paths/.
```

CLI and panel never talk to each other; they both talk to the Connect API. That part of INTENT is upheld. The diagram's leaky edges are the audit findings below.

## Summary

The high-level layering is sound. `cmd/<bin>/main.go` files are thin; each binary lives in its own `internal/<bin>/` tree; CLI and panel are both Connect clients, never importing the server's handlers; `internal/store/` is SQLite-only; `internal/server/handlers/` is Postgres+S3-only; the proto package is the single typed contract. No `pkg/` package imports any `internal/` package, and no panel code reaches into `internal/store/`. Those four bright-line rules are intact.

What's drifting is the *boundary between code that should be shared and code that should be local*. Several packages exist as "helpers" with fewer than three call sites (`internal/projectlabel/`, parts of `internal/legacy/`, `pkg/httpserver/`); the `schedule.Scheduler` interface has one production implementation per `GOOS` and is the textbook example of "one call site, scrap it". Analytics is duplicated: `internal/store/analytics.go` builds the SQLite version of the queries, and `internal/server/handlers/analytics.go` builds a Postgres copy of the same SQL by hand with no shared dialect, no shared headers, no shared row scaffolding — so the CLI does post-hoc fix-up in `analyticsProtoResult`/`normalizeRemoteAnalyticsResult`.

The single largest crossed-responsibility offender is `internal/cli/sync.go` (701 lines): it owns CLI argument parsing, importer registry, project-identity backfill, two parallel orchestrators (interactive + plain), a render layer (`printSummaryTTY`), Bubble Tea wiring, push outcome bookkeeping, and the `syncCounts` mini-state-machine. It is doing the job of an orchestration package, a renderer, and a small business module simultaneously. Everything else flagged is comparatively cheap to fix.

## Findings

### Schedule.Scheduler — one production impl per platform — medium

**Location:** `internal/cli/schedule/schedule.go:24`

The `Scheduler` interface has exactly two implementations (`macScheduler`, `linuxScheduler`), and they are selected by `GOOS` at `New()`. There is no test fake, no remote scheduler, no in-process scheduler. The interface buys nothing the package couldn't get from exporting `Install`/`Uninstall`/`Status` as top-level functions that switch on `runtime.GOOS` inside. Per INTENT § *How I think when I code*: "Three call sites or it's not a helper."

**Suggested fix:** Delete the interface. Promote `macSchedulerInstall`/`linuxSchedulerInstall` etc. to package-level functions. The single dispatcher (`schedule.Install(ctx, bin, interval)`) switches on GOOS and returns `ErrUnsupported` for the default case — same surface, zero indirection. Tests can call the platform-specific functions directly.

### internal/cli/sync.go does five jobs in one file — high

**Location:** `internal/cli/sync.go` (whole file, 701 lines)

`sync.go` mixes: (1) command/flag wiring, (2) importer registry construction, (3) device + project identity backfill, (4) two orchestrators (`runSyncInteractive`/`runSyncPlain`), (5) rendering (`printSummary`, `printSummaryTTY`, `printSummaryTTYRow`, `padSummaryLabel`), and (6) the `syncCounts` state machine. The render and orchestrator concerns belong in different files at minimum; ideally the renderer goes in `internal/cli/render/` because that is the package that owns "how the CLI looks". Cross-package call: `print*` here use `render.StyleHeader`/`StyleRail`/`StyleMuted`/`StyleSuccess`/`StyleSkipped`/`StyleError` from the render package, but the orchestration of those styles into sync-summary layout lives in cli root — which is exactly the inverted dependency that the rendering-contract doc tries to avoid.

**Suggested fix:** Split into `sync.go` (RunE + work assembly), `sync_summary.go` (move `syncCounts`, `printSummary*`, `padSummaryLabel`, `printSummaryTTYRow` either here or into `internal/cli/render/sync_summary.go`), and `sync_run.go` (the two orchestrators). The `syncCounts` struct + `record`/`recordPush` is small enough to keep where it lives, but the rendering needs to move out of the file that also calls `runSync` and `prepareLegacyWork`.

### Analytics SQL is forked between local and remote — high

**Location:** `internal/store/analytics.go` and `internal/server/handlers/analytics.go`

Both files reimplement the same five analytics queries (`sessions`, `tools`, `models`, `projects`, `usage` plus `heatmap`/`errors`) — once in SQLite-flavored SQL with `*Store` methods, once in Postgres-flavored SQL inside a Connect handler. Headers are emitted independently on each side. The local store returns `store.AnalyticsResult{Headers, Rows[]AnalyticsRow{Values []any}}`; the proto returns `prosav1.AnalyticsRow{Values []string}`. The CLI then has `analyticsProtoResult` and `normalizeRemoteAnalyticsResult` (`internal/cli/analytics.go:246/258`) to *paper over the difference between the two SQL implementations* — e.g. remote `heatmap` returns three columns (`DATE,AGENT,SESSIONS`) but local returns two, so the CLI rolls them up at the boundary. That is the symptom: the contract isn't actually a contract; the dialects drift, and the CLI absorbs the drift.

**Suggested fix:** The proto `GetReport` should be the single shape. Either (a) make the local SQLite analytics return the same Headers+Rows shape as the server (canonicalize on the proto), so the CLI has one code path for both backends, or (b) extract the query *definitions* (headers, group-bys, order) into a shared, dialect-neutral spec and have each backend instantiate them. (a) is cheaper. Today both backends carry SQL-by-hand for the same five reports.

### `internal/cli/` hardcodes auth.json path strings — medium

**Location:** `internal/cli/rpc/client.go:22` (comment), `internal/cli/login.go:165,229`, `internal/cli/sync_push.go:30`

Comments and user-facing strings reference `~/.config/prosa/auth.json` literally. `internal/paths` is the documented choke point (`docs/architecture/README.md` §Paths: "If you find a hardcoded path elsewhere, that is a bug."). The Go *code* does go through `paths.AuthPath()` correctly, but the user-facing messages in `login.go` lie when `PROSA_CONFIG_HOME` or `XDG_CONFIG_HOME` is set — they advertise a path that is not the one being written.

**Suggested fix:** Compute the displayed path at print time via `paths.AuthPath()` (it's already imported in `rpc/client.go`). Lipgloss styling is orthogonal — just feed the resolved string in. The `~/.config/prosa/auth.json` in comments can stay or be reworded; the user-facing strings should not.

### Importer roots bypass `internal/paths` — medium

**Location:** All importers: `internal/importers/{claudecode,codex,cursor,gemini,antigravity,hermes}/importer.go` plus `internal/cli/schedule/{linux,macos}.go`

Every importer calls `os.UserHomeDir()` directly to compute its `DefaultRoots()` (e.g. `~/.claude/projects`, `~/.codex/sessions`). These are *agent* home dirs, not prosa's home dir, so they aren't covered by `paths.Home()` today. Strictly speaking this is consistent with INTENT — prosa's path discipline is about *prosa's* layout, not the agents'. But INTENT phrases it categorically ("Never hardcode `~/...` in arbitrary code"), and the test seam is sad: there's no way to point an importer at a fixture root in tests without setting `$HOME`. The `schedule/linux.go` and `schedule/macos.go` `os.UserHomeDir()` calls install systemd/launchd files into the user's home, which is fine, but again means tests must hijack `$HOME`.

**Suggested fix:** Add a small `paths.UserHome()` (one line wrapping `os.UserHomeDir`) so a future test override (env var, or test hook) can apply everywhere. Or accept that agent home dirs are out of scope and update the docs note to say "prosa's data/config" rather than "any `~`".

### `pkg/httpserver` is two call sites, both inside `internal/` — medium

**Location:** `pkg/httpserver/httpserver.go` (entire 43 lines)

Two call sites only: `internal/server/server.go:82` and `internal/panel/server.go:92`, both passing the same 5-second grace timeout. It's exported as `pkg/`, but nothing outside `internal/` uses it and nothing is likely to (this is a 3-binary, single-module repo). Per INTENT, exportable means "third parties may import" — there is no third-party consumer of "run an http.Server with a 5-second graceful shutdown".

**Suggested fix:** Move to `internal/httpserver/` (or inline the 20 lines into both servers — it's small enough that the third-call-site rule allows inlining). Keeping it as `pkg/` advertises a public API surface that does not need to exist.

### `internal/projectlabel/` has two call sites — medium

**Location:** `internal/projectlabel/projectlabel.go` — called only from `internal/cli/render/timeline.go:114,323`

`projectlabel.Label(s)` is invoked from exactly one file in production code, twice. The package has 95 lines and a comprehensive test file. Per INTENT § *How I think when I code*: "Three call sites or it's not a helper. One call site stays inline." Today it's one *file* with two near-adjacent calls — borderline. The CLI panel and server analytics handlers don't use it (they emit the proto columns and the panel renders its own label logic in templates, server returns raw project columns); so the cross-binary value the package was created for hasn't materialized.

**Suggested fix:** Either grow callers (the panel and the server's project analytics should arguably use the same label normalization for consistency — that's the third call site), or fold the 80 lines into `internal/cli/render/timeline.go` directly. Keep the tests next to whichever home it ends up in. Do not let it sit as a one-file dependency.

### `internal/cli/sync_push.go` has the only `*pusher` instance — low

**Location:** `internal/cli/sync_push.go:25` (`pusher` struct, lower-case unexported)

This is correct: a concrete struct with no interface, used only inside `internal/cli/`. Calling it out as the *right* shape against the wrong-shape candidates above. No change.

### `internal/server/handlers/sessions.go:678` — `scannable` interface — low

**Location:** `internal/server/handlers/sessions.go:678`

A 3-line interface to abstract over `pgx.Row` and `pgx.Rows`. One call site (`scanSessionRow`). Pure plumbing, but it has the right shape for the job — pgx itself does not expose a shared parent type. Acceptable.

### `pkg/session.Session` does double duty as proto-adjacent and store-adjacent — low

**Location:** `pkg/session/types.go`

The package is correctly minimal (one types.go, one test). But it serves both as the canonical type that importers fill (where it makes sense) and as the type that the CLI hand-maps to/from `prosav1.Session` (`internal/cli/sync_push.go:125 sessionToProto`, `internal/cli/show.go:188 remoteSessionToLocal`). Three converters live in the CLI: `sessionToProto`, `turnsToProto`, `toolsToProto`, and their inverses in `show.go`. This is fine for now (proto types carry presence bits that domain types don't), but as more services land the conversion drift will grow — consider whether the canonical type could be the generated proto, with `pkg/session` providing only validation helpers. Not urgent; flag for next round.

### `pkg/session/types.go` projection version constant — low

**Location:** `pkg/session/types.go` defines `ProjectionVersion`, used by `internal/store/sessions.go` and `internal/server/handlers/sessions.go`

The constant correctly travels with the domain type and is read on both sides (push idempotency). This is exactly what `pkg/` is for — shared semantics across binaries. Note that the panel does NOT read this constant; only the server checks the wire version. Correct shape.

### Migration ownership is clean — nit

Local migrations apply on `store.Open()` (only the CLI writes); read-only opens explicitly refuse to migrate (`store.go:108 checkSchemaCurrent`). Server migrations apply on `storage.OpenPG()` (only the server writes Postgres). No one runs both. No tool exists to "force migrate" externally. This is the right shape.

### `internal/cli/render/` vs `internal/panel/render/` — nit

These share a name and a verb but do entirely different jobs: cli/render formats terminal output (Lipgloss styles, timeline rows, prompts), panel/render produces HTML (goldmark Markdown rendering, turn groupings for HTMX templates). The only overlap is `HumanDuration` (panel/render/duration.go) vs the `humanDur` test helper in `cli/spinner/sync_test.go:190` — minor and contained. The two packages have separate, justified existences. Not duplication, just shared naming.

### `internal/buildinfo`, `internal/device`, `internal/legacy`, `internal/sessiontext`, `internal/projectid`, `internal/pricing` — nit

All shared utility packages with multi-call-site use. `device` is used by every importer plus `sync.go`. `sessiontext` is used by every importer and by `store` (for boilerplate prefix SQL) and by panel handlers. `pricing` is used by both the local `store/analytics.go` and the remote `server/handlers/analytics.go`. None of these are "util" smell — they're concrete, narrow, and have ≥3 call sites. No `util`/`common`/`helpers` package exists. Good.

### Server doesn't import importers — nit

Verified: `grep` of `internal/server/` shows zero imports of `internal/importers/`. Server is store+S3 only. Push uploads pre-projected data; importers run only in the CLI. Boundary respected.

### `internal/server/handlers/` defines only handler-config types — nit

The five `*Handler` structs and `scannable` interface are the only types. No business types should-have-been-proto types. The wire shape is `prosav1.*` exclusively. Good.

## What I checked

- `INTENT.md`, `AGENTS.md`, `docs/architecture/README.md`.
- `grep -rh '"github.com/c3-oss/prosa/' --include='*.go' cmd/ internal/ pkg/ | sort -u` — all internal-module imports.
- Per-package import lists for `internal/cli`, `internal/panel`, `internal/server`, `internal/store`, `internal/importers`, `pkg/httpserver`, `pkg/importer`, `pkg/session`.
- `internal/cli/sync.go` (701 LOC, full read), `sync_push.go`, `sync_reconcile.go`, `sync_denoise.go`, `setup.go`, `analytics.go`.
- `internal/store/store.go`, `sessions.go`, `analytics.go`, `turns.go`.
- `internal/server/server.go`, `handlers/sessions.go`, `handlers/analytics.go`.
- `internal/panel/server.go`, `render/*.go`, `handlers_views.go`.
- All interfaces in non-test code: `grep -rn '^type [A-Z][A-Za-z]* interface' --include='*.go'`.
- All `*.Store` method count (44 production methods).
- Hardcoded path search: `grep -l 'os.UserHomeDir\|XDG_\|~/.config\|~/.local'`.
- `pkg/httpserver/httpserver.go`, `pkg/importer/importer.go`, `pkg/session/types.go`.
- `internal/paths/xdg.go`, `internal/projectlabel/projectlabel.go`, `internal/sessiontext/parse_user.go`, `internal/projectid/projectid.go`.
- Generated proto users: `grep -rn 'prosav1\.\|prosav1connect\.'`.

## Recommendations

1. **Unify analytics.** Pick one query spec; let SQLite and Postgres each render it with their own dialect helpers. Eliminate `normalizeRemoteAnalyticsResult` at the CLI boundary by making local + remote return the same `prosav1.AnalyticsRow` shape. This is the highest-leverage cleanup — removes a real source of subtle drift (e.g. the heatmap column-count mismatch).
2. **Split `internal/cli/sync.go`.** Move the `printSummary*` family and `syncCounts` rendering helpers into a sibling file (`sync_summary.go`) or into `internal/cli/render/`. Keep `runSync`, `runSyncInteractive`, `runSyncPlain` in their own files. A 701-line orchestrator is the textbook "where do I add the next feature" pain point.
3. **Delete the `schedule.Scheduler` interface.** Promote `Install`/`Uninstall`/`Status` to top-level functions that switch on `runtime.GOOS`. Saves one indirection layer with zero loss of flexibility.
4. **Fold `pkg/httpserver` and re-home `internal/projectlabel`.** Move `httpserver` to `internal/httpserver` (or inline) because no external consumer exists. Either give `projectlabel` real cross-binary call sites (panel + server analytics) or inline it.
5. **Pipe user-facing path strings through `paths`.** `login.go` and `sync_push.go` should never hardcode `~/.config/prosa/auth.json` in user-visible output — they already import `paths`; use it for the *display* string too.
