# CLI Rendering Contract

This document is the implementable rendering contract for Prosa CLI output.

## Modes

Every renderer supports:

- interactive TTY mode;
- plain/script mode.

Commands that support `--json` also support machine-readable mode. In
machine-readable mode, `stdout` must contain only JSON or NDJSON documented by
the command.

## Semantic Tokens

TTY color is semantic, not decorative. Use a soft palette by default. Avoid
pure bright ANSI colors for normal UI because they dominate dense terminal
output and vary aggressively across terminal themes.

Primary prose and prompts should use the terminal's default foreground. The
palette below is for metadata, state, and visual structure.

| Token | Meaning | Truecolor | 256-color | Treatment |
| --- | --- | --- | --- | --- |
| `foreground` | primary text | terminal default | default | normal |
| `muted` | time, duration, paths | `#8A8F98` | `245` | normal |
| `rail` | rails and separators | `#3A3F46` | `238` | normal |
| `accent` | command context | `#8AB4D6` | `110` | normal |
| `device` | device identity | `#7FB3C8` | `109` | normal |
| `agent` | importer or agent identity | `#D6B97A` | `179` | normal |
| `project` | project identity | `#8CBF88` | `108` | normal |
| `active` | active session marker | `#D7827E` | `174` | bold |
| `match` | search match | `#D6B97A` | `179` | underline or bold |
| `success` | completed step or imported count | `#8CBF88` | `108` | normal |
| `skipped` | no-op/skipped count | `#8A8F98` | `245` | normal |
| `warning` | recoverable warning | `#D6B97A` | `179` | normal |
| `error` | fatal or per-item error | `#D7827E` | `174` | normal or bold for fatal |
| `header` | day or command header | terminal default | default | bold |

Plain/script mode emits no ANSI sequences.

### Palette Rules

- Prefer terminal default foreground for readable content.
- Use dim gray for metadata before adding hue.
- Use hue sparingly: one semantic accent per segment is enough.
- Do not use saturated ANSI `31`, `32`, `33`, `36`, or `196` as default UI
  colors.
- Do not use red for search matches; reserve rose/error tones for active,
  failed, or risky state.
- Underline or bold can carry emphasis when color is unavailable.
- The UI must remain understandable with color disabled.
- If truecolor is unavailable, use the listed 256-color indices through
  Lipgloss.

## Structural Symbols

Allowed symbols and meanings:

| Symbol | Meaning |
| --- | --- |
| `│` | grouped output rail |
| `├` | intermediate child detail |
| `└` | final child detail |
| `─` | separator in animated status surfaces |
| `→` | active step |
| `⤷` | derived metadata or snippet |
| `·` | compact metadata separator |
| `*` | active session |
| `…` | truncation |

Do not use emoji.

## Output Channels

Use `stdout` for command data:

- timeline rows;
- search rows;
- analytics rows;
- raw JSONL;
- final summaries;
- JSON/NDJSON streams.

Use `stderr` for operational context:

- auto-scope notices;
- progress;
- warnings;
- importer errors;
- cancellation notices;
- logs.

For non-interactive automation, progress may stream to `stderr` while the final
result remains pipeable on `stdout`.

## Timeline

Interactive timeline output groups sessions by day.

Header rules:

- today: `Today`;
- yesterday: `Yesterday`;
- 2 to 7 days old: `N days ago`;
- 7 to 30 days old: weekday name;
- older than 30 days: absolute date such as `May 02`.

Scoped row grammar:

```text
Today
│ HH:MM[*] device  agent  project  "first prompt"
│        ├ id        <session-id>
│        └ duration · tool, tool, tool
```

Global row grammar:

```text
Today
│ HH:MM[*] project  device  agent  "first prompt"
│        ├ id        <session-id>
│        └ duration · tool, tool, tool
```

The `id` row carries the session id verbatim (no truncation) so it is
copy-pasteable into `prosa show <id>`. The label is `muted`; the id
itself is `accent`. The row is only emitted in TTY mode; plain output
already exposes the id as the first tab-separated column.

Rules:

- The active marker is `*` immediately after the time.
- A session is active when `last_activity` is less than 10 minutes old.
- Show up to three top tools, comma-separated.
- Missing project renders as `-` in rows and `(unscoped)` in analytics.
- The first prompt is quoted and truncated with `…`.
- Use a light left rail only in TTY mode.

Plain timeline rows are tab-separated:

```text
started_at_utc	device	agent	project	duration	first_prompt
```

Do not print day headers or rails in plain mode.

## Scope-Aware Suppression

When the set of rows about to render share the same value for a
column, that column is dropped from every row and the value lives in
the context line instead. Applies to:

- `device`: dropped when there's only one distinct device id in the
  rendered set.
- `project`: dropped when the layout is scoped (the context line
  already names the project), or when there's only one distinct
  project label across rows.

`agent` is never dropped, even when it's uniform — agent identity is
central enough that repetition is preferable to absence.

In plain mode (pipes / `--json`), the suppression rule does not apply:
every column is always emitted so downstream scripts have a stable
column shape.

### First-prompt boilerplate

`first_prompt` rows often carry agent-injected meta-messages
(`# AGENTS.md instructions for …`, `<command-name>…</command-name>`,
`<system-reminder>…</system-reminder>`, `<environment_context>…`,
`<local-command-caveat>…</local-command-caveat>`, "You are Codex,
a coding agent", "Knowledge cutoff: …"). When the value matches one
of those known prefixes — or wraps a real prompt inside a known tag —
the renderer substitutes the muted placeholder `(meta)` so the row
is honest about the absence of real user content. The classifier
lives in `internal/sessiontext` and is shared by importers, the
renderer, and the SQL denoise sweep so the pattern list never
drifts. `prosa sync` runs a one-shot denoise pass that rewrites the
row in place by reopening the raw JSONL and extracting the first
non-boilerplate user message.

### Device label

`device_id` is the stable per-machine fingerprint hex. The renderer
substitutes the device's `friendly_name` (from
`prosa devices rename`) before display; when no friendly_name is
known, falls back to the first 7 hex chars + `…`. Plain mode keeps
the raw fingerprint hex for script stability.

## Auto Scope Notices

When the command auto-detects a project from the current working directory,
human output prints a short notice to `stderr`.

Timeline:

```text
prosa · local · scoped to prosa · last 7d
```

The tail segment after scope reflects whichever window flag is active.
Exactly one of three shapes:

- `last <duration>` — rolling window from `--last` (default `7d`).
- `since <YYYY-MM-DD>` — anchored lower bound from `--since`.
- `between <YYYY-MM-DD> and <YYYY-MM-DD>` — closed range from `--between`.

Search:

```text
search · local · scoped to prosa · "sqlite"
```

Do not print scope notices in JSON/NDJSON mode.

## Width And Density

The 80-column layout is the baseline.

Preservation order:

1. command meaning;
2. time and active marker;
3. project;
4. agent;
5. prompt or search snippet;
6. duration;
7. tools;
8. device;
9. absolute paths.

Compression rules:

- Truncate prompt and snippet text before structural metadata.
- Shorten device names before project names.
- Collapse secondary metadata into the detail row below 80 columns.
- Truncate paths from the left.
- Use `…` as the only truncation marker.
- Avoid wrapping rows unless the content is raw output.

## Search

Interactive search renders one evidence block per hit:

```text
│ <short-id>  prosa · codex · laptop · Today 13:42
│   user       add a local sqlite store for session metadata and FTS
│   session    "index importer sessions"
```

Rules:

- the session id is the first segment of the header line, truncated to
  its first 12 runes (no trailing ellipsis — prefix is recognizable);
- show project, agent, device, and timestamp in `·`-separated metadata;
- show the matching role, such as `user` or `assistant`, in the body;
- the body uses plain indent (no `├` / `└` branches) for visual quietness;
- highlight only matched text;
- keep snippets single-line by default;
- end with a compact match count and raw-view hint when useful.

Plain search rows are tab-separated:

```text
session_id	agent	project	date	role	snippet
```

Plain snippets contain no highlight markers unless a future flag explicitly
requests them.

## Sync

Interactive sync uses compact progressive feedback.

Progress grammar (two checklist rows; active `→`, completed `✓`). One blank
line precedes the header after the shell prompt.

```text

prosa sync · local store
────────────────────────────────────────────────────────────────────────
found          codex 48 · claude-code 41 · cursor 7 · gemini 0

→ local        importing  17 / 96 · imported 12 · skipped 5 · errors 0 · 8s · eta 36s
· remote       pending
  current      codex · …/2026/05/30/session-a.jsonl
```

When catch-up runs after local import (local row collapses to elapsed time):

```text
✓ local        24s
→ remote       reconciling  12 / 37 · sent 10 · skipped 2 · errors 0 · 4s · eta 8s
  current      remote · sess-9a3c…
```

When both phases finish, checklist rows stay compact; imported/skipped/sent
counts appear only in the summary below.

```text
✓ local        17s
✓ remote       18s · local 2 912 · remote 2 799
```

Final summary grammar (authoritative counts):

```text
prosa sync · complete

Live:     imported N · skipped N · errors N
Legacy:   imported N · skipped N · errors N (of N catalog rows)
Push:     sent N · skipped N · errors N
Catch-up: sent N · skipped N · errors N  (local L · remote R)
Remote:   server unavailable at <server>; local import is saved. Run `prosa sync` again when it is back.
```

`Legacy` only appears when `--legacy-bundle` was passed. `Push` and
`Catch-up` only appear when the device is logged in to a prosa-server
(i.e. when `~/.config/prosa/auth.json` exists). `Catch-up` is the
manifest-driven reconcile that makes the remote converge to the local
set; `Catch-up: sent 0` on a re-run is the new idempotency criterion.
`Remote` appears only when that auth file exists but the server cannot
be reached; it replaces raw transport warnings and does not make the
local import fail.

Plain sync uses structured logs plus the same factual summary. It must not use
spinners, cursor movement, alternate screen, or ANSI escapes.

## Setup And Login

Setup and login use a checklist grammar:

```text
prosa setup
cwd    /path/to/project
store  ~/.local/share/prosa

✓ device       laptop · darwin/arm64
✓ server       https://prosa.c3.do
→ auth         waiting for browser approval
```

Rules:

- Use `✓` for completed steps.
- Use `→` for the active step.
- Use short nouns for labels.
- Show recovery URLs plainly.
- In plain mode, print stable key/value rows.

## Show

`prosa show <session-id>` has three output shapes; the renderer
picks one based on flags and TTY context:

1. **Rendered (default in a TTY)** — a structured human view:
   header line with project · agent · device, a metadata block
   (`id`, `started`, `duration`, `model`, `tools`, `raw`), then a
   `turns` section. Tool projections appear as
   `tool:<name>` rows (e.g. `tool:Bash npm test failed with exit 1`);
   chat turns show the bare role.
2. **JSON (`--json`)** — a single object with `session`, `tools`,
   and `turns`. Stdout carries the JSON only; nothing else.
3. **Raw (`--raw`, `--remote --raw`, or non-TTY without flags)** —
   preserved raw JSONL bytes, byte-identical to the source. Stdout
   carries only the raw; no preface. Pipeable:
   `prosa show <id> --raw | jq`.

`--max-output-lines N` caps per-turn rendered/JSON line count;
`0` means no cap. `--remote` fetches the same payload from
prosa-server; when combined with `--raw`, raw bytes stream through
`GetRaw`.

## Analytics

Analytics output is a dense table.

Rules:

- headers are muted and bold in TTY;
- numeric columns may use the soft `accent` token;
- no chart glyphs;
- no progress bars;
- no decorative dashboard framing;
- align columns by display width, not byte length.

Plain analytics output is tab-separated with a header row.

## Empty States

Empty states are short and diagnostic.

Timeline:

```text
no sessions found
run `prosa sync` to import local agent history
```

Scoped timeline:

```text
no sessions found for prosa
use `prosa --all` to show every project
```

Search:

```text
no matches
try `--all`, widen the window, or search a broader term
```

Analytics:

```text
no rows
```

## Errors

Fatal errors use the root command format:

```text
error: session abc123 not found
```

Prefer object-first errors:

```text
error: raw file missing: /path/to/session.jsonl
```

Importer errors inside `sync` can be per-item errors and do not need to abort
the whole run if remaining items can still be processed.

Never print stack traces by default.
