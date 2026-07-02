# CLI Screen Mocks

These mocks show what commands print before exiting. They are structure mocks:
color is described in the rendering contract and is not encoded in these
blocks.

## 1. `prosa` With Auto-Detected Project

Human TTY output prints scope context to `stderr` and timeline data to
`stdout`. The context line is intentionally compact.

```text
prosa · local · scoped to c3-oss/prosa · last 7d

Today
│ 11:24  claude-code  "refactor sync logic"
│        ├ id        claude-2026-05-30-1a2b3c4d
│        └ 32min · edit, bash
│
│ 09:02* codex        "setup importer tests"
│        ├ id        codex-2026-05-30-5e6f7g8h
│        └ 18min · write, grep

Yesterday
│ 23:55  claude-code  "intent doc"
│        ├ id        claude-2026-05-29-9i0j1k2l
│        └ 1h12 · edit, write, bash
```

Scope-aware suppression drops `device` (cardinality 1) and `project`
(already named in the context line) from each row. The `id` row
carries the full session id so `prosa show <id>` is a copy/paste away
— the id is rendered in `accent` and the label in `muted`, so it
reads as auxiliary metadata, not as the primary content.

The context line's tail segment reflects whichever window flag was
active. Three shapes, mutually exclusive:

```text
prosa · local · scoped to c3-oss/prosa · last 7d
prosa · local · scoped to c3-oss/prosa · since 2026-01-01
prosa · local · scoped to c3-oss/prosa · between 2026-01-01 and 2026-03-15
```

Plain output omits human context and uses one stable row per session.

```text
2026-05-30T14:24:00Z	laptop	claude-code	/Users/upsetbit/Projects/c3/c3-oss/prosa	32min	refactor sync logic
2026-05-30T12:02:00Z	laptop	codex	/Users/upsetbit/Projects/c3/c3-oss/prosa	18min	setup importer tests
2026-05-29T02:55:00Z	laptop	claude-code	/Users/upsetbit/Projects/c3/c3-oss/prosa	1h12	intent doc
```

## 2. `prosa --all` With Many Sessions

The global view uses the same row grammar, but project identity becomes the
primary scanning anchor after time.

```text
prosa · local · all projects · last 7d

Today
│ 16:31  prosa       Studio M4  codex        "design CLI output docs"
│        ├ id        codex-2026-05-30-a1b2c3d4
│        └ 41min · read, write, rg
│
│ 14:08  dotfiles    laptop     claude-code  "fix zsh completion path"
│        ├ id        claude-2026-05-30-e5f6g7h8
│        └ 22min · edit, bash
│
│ 11:56* infra-prod  remote-1   codex        "debug deploy health check"
│        ├ id        codex-2026-05-30-i9j0k1l2
│        └ 1h04 · read, bash, curl

Yesterday
│ 18:03  c3-api      remote-1   claude-code  "trace postgres migration failure"
│        ├ id        claude-2026-05-29-m3n4o5p6
│        └ 49min · bash, edit
```

The `device` column shows the device's `friendly_name` (settable via
`prosa devices rename`). When there's only one device known to the
store, the column is suppressed altogether — see `prosa` scoped (§1)
above for that case.

Plain output remains one row per session.

```text
2026-05-30T19:31:00Z	laptop	codex	/Users/upsetbit/Projects/c3/c3-oss/prosa	41min	design CLI output docs
2026-05-30T17:08:00Z	mbp	claude-code	/Users/upsetbit/Projects/_me/dotfiles	22min	fix zsh completion path
2026-05-30T14:56:00Z	remote-1	codex	/srv/infra-prod	1h04	debug deploy health check
```

## 3. Timeline In An 80-Column Terminal

At 80 columns, preserve time, active marker, project, agent, and prompt.
Shorten device before project, and truncate prompts before removing structure.

```text
prosa · local · all projects · last 7d

Today
│ 16:31  prosa       codex   laptop  "design CLI output docs"
│        ├ id        codex-2026-05-30-a1b2c3d4
│        └ 41min · read, write, rg
│
│ 11:56* infra-prod  codex   rem-1   "debug deploy health check for…"
│        ├ id        codex-2026-05-30-i9j0k1l2
│        └ 1h04 · read, bash, curl
```

Below 80 columns, the device column shrinks in place first (floor 8),
then project (floor 14); prompts absorb the rest. Keep the row
single-purpose and readable.

```text
Today
│ 16:31  prosa       codex   laptop  "design CLI…"
│        ├ id        codex-2026-05-30-a1b2c3d4
│        └ 41min · read, write, rg
│
│ 11:56* infra-prod  codex   rem-1   "debug deplo…"
│        ├ id        codex-2026-05-30-i9j0k1l2
│        └ 1h04 · read, bash, curl
```

## 4. `prosa search "sqlite"`

Human TTY search output is an evidence list. It should make the match location
and role obvious without using a full table.

The `«sqlite»` markers below indicate where TTY highlighting is applied.

```text
search · local · scoped to c3-oss/prosa · "sqlite"

│ 57f476a0-8e1  codex · Today 13:42
│   user       add a local «sqlite» store for session metadata and FTS
│   session    "index importer sessions"
│
│ 6ffc5138-41a  claude-code · Yesterday 21:18
│   assistant  the «sqlite» migration needs the devices seed row before sessions
│   session    "debug migration"
│
│ 019e240b-0ac  codex · Wednesday 10:04
│   user       can FTS5 rank «sqlite» snippets by recency too?
│   session    "search ranking"

3 matches · use `prosa show <id>` for raw JSONL
```

Scope-aware suppression at work: project is dropped because the
context line already says "scoped to c3-oss/prosa", and device is dropped
because every hit shares the same device. When either dimension
varies across hits, that column comes back as a `·`-separated
segment in the header.

The session id is shortened to its first 12 runes in the header line —
enough to identify and (almost always) enough to disambiguate a `prosa
show <prefix>` call without showing the entire UUID.

Plain output strips highlight markers and uses tab-separated rows.

```text
codex-2026-05-30-1342	codex	/Users/upsetbit/Projects/c3/c3-oss/prosa	2026-05-30 13:42	user	add a local sqlite store for session metadata and FTS
claude-2026-05-29-2118	claude-code	/Users/upsetbit/Projects/c3/c3-oss/prosa	2026-05-29 21:18	assistant	the sqlite migration needs the devices seed row before sessions
codex-2026-05-28-1004	codex	/Users/upsetbit/Projects/c3/c3-oss/prosa	2026-05-28 10:04	user	can FTS5 rank sqlite snippets by recency too?
```

## 5. `prosa sync` Interactive Progress

The interactive surface is bounded and updates in place. These are successive
frames, not separate appended outputs. One blank line separates the shell
prompt from the header.

```text

prosa sync · local store
────────────────────────────────────────────────────────────────────────
found          codex 48 · claude-code 41 · cursor 7 · gemini 0

→ local        importing  17 / 96 · imported 12 · skipped 5 · errors 0 · 8s · eta 36s
· remote       pending
  current      codex · …/2026/05/30/session-a.jsonl
```

```text
prosa sync · local store
────────────────────────────────────────────────────────────────────────
found          codex 48 · claude-code 41 · cursor 7 · gemini 0

✓ local        24s
→ remote       reconciling  12 / 37 · sent 10 · skipped 2 · errors 0 · 4s · eta 8s
  current      remote · sess-9a3c…

errors
  cursor       …/chats/2026-05-29/session-c.jsonl
               parse message: missing timestamp
```

Final checklist frame (compact `✓` rows — counts live in the summary):

```text
✓ local        17s
✓ remote       18s · local 2 912 · remote 2 799
```

Final output after the progress program exits:

```text
prosa sync · complete

Live:     imported 44 · skipped 51 · errors 1
Push:     sent 44 · skipped 0 · errors 0
Catch-up: sent 0 · skipped 0 · errors 0  (local 2 815 · remote 2 815)
Denoise:  cleaned 12 prompts
```

`Push` and `Catch-up` only appear when the device is logged in to a
prosa-server; `Denoise` only appears when at least one session's
`first_prompt` got rewritten in place.

When the local import succeeds but the configured server is unavailable,
`sync` stays local-first and ends with a single friendly remote status:

```text
prosa sync · complete

Live:     imported 27 · skipped 1800 · errors 0
Push:     sent 0 · skipped 0 · errors 0
Remote:   server unavailable at http://localhost:7070; local import is saved. Run `prosa sync` again when it is back.
```

## 6. `prosa sync` Plain/Script Mode

Plain mode uses structured log lines on `stderr` plus a stable summary on
`stdout`. It has no spinner, cursor movement, alternate screen, or ANSI escapes.

```text
time=2026-05-30T16:31:22-03:00 level=INFO msg=imported agent=codex session=codex-2026-05-30-1342 status=done legacy=false dur=41ms
time=2026-05-30T16:31:22-03:00 level=INFO msg=imported agent=claude-code session=claude-2026-05-29-2118 status=skipped legacy=false dur=12ms
time=2026-05-30T16:31:23-03:00 level=ERROR msg="import failed" agent=cursor path=/Users/upsetbit/.cursor/chats/session-c.jsonl legacy=false err="parse message: missing timestamp"
Live:    imported 44, skipped 51, errors 1
```

With a legacy bundle:

```text
Live:    imported 12, skipped 38, errors 0
Legacy:  imported 204, skipped 6810, errors 3 (of 7017 catalog rows)

Legacy bundle mirrored in the prosa store: /Users/upsetbit/.prosa
```

## 7. `prosa setup` / `prosa login`

`setup` walks a fresh machine from zero to a self-syncing install
in six rows. Active step is `→`; completed steps stay on screen as
`✓` after the command exits.

```text
prosa setup
cwd    /Users/upsetbit/Projects/c3/c3-oss/prosa
store  /Users/upsetbit/.local/share/prosa

✓ agents       claude-code · codex · cursor · gemini
✓ server       https://prosa.c3.do
→ auth         waiting for browser approval

Open this URL if the browser did not start:
  https://prosa.c3.do/device?code=7F4C-D91A
  7F4C-D91A
```

The agents row colors each importer by availability:
agent-style for the ones whose default roots exist on this
machine, muted for the ones with no data on disk yet.

After approval, the URL block collapses in place into a single
"✓ auth approved" line. The scheduler and first scan steps continue
from there. The last line is the final ready banner, printed below
sync's own progress UI:

```text
prosa setup
cwd    /Users/upsetbit/Projects/c3/c3-oss/prosa
store  /Users/upsetbit/.local/share/prosa

✓ agents       claude-code · codex · cursor · gemini
✓ server       https://prosa.c3.do
✓ auth         approved
✓ scheduler    LaunchAgent · every 15m0s
→ first scan

prosa sync · complete

Live:     imported 44 · skipped 0 · errors 0
Push:     sent 44 · skipped 0 · errors 0
Catch-up: sent 0 · skipped 0 · errors 0  (local 44 · remote 44)

ready · next sync in 15m0s
```

`prosa setup --skip-scan` exits right after the scheduler row,
leaving sync for later (e.g. when the user is ready to wait).

`login` uses the auth subset:

```text
prosa login

✓ device       laptop
✓ server       https://prosa.c3.do
→ auth         waiting for browser approval

Open this URL if the browser did not start:
  https://prosa.c3.do/device?code=E20B-61C9
  E20B-61C9
```

Plain/script mode (either piped or `--non-interactive`) replaces
the ANSI redraw with stable key=value rows on `stdout`:

```text
step=cwd	value=/Users/upsetbit/Projects/c3/c3-oss/prosa
step=store	value=/Users/upsetbit/.local/share/prosa
step=agents	value=claude-code,codex,cursor,gemini
step=server	value=https://prosa.c3.do
step=auth	status=cached
step=scheduler	status=installed	kind=LaunchAgent	interval=15m0s
step=first_scan	status=skipped
status	ready
```

`prosa login` plain mode keeps the auth handshake intermediate
states explicit:

```text
device	laptop
server	https://prosa.c3.do
auth_url	https://panel.example.com/cli/authorize?request_id=abc123
status	waiting_for_approval
status	approved
```

## 8. Empty States And Errors

No sessions:

```text
prosa · local · last 7d

no sessions found
run `prosa sync` to import local agent history
```

No sessions with auto-scope:

```text
prosa · local · scoped to c3-oss/prosa · last 7d

no sessions found for prosa
use `prosa --all` to show every project
```

No search results:

```text
search · local · scoped to c3-oss/prosa · "sqlite"

no matches
try `--all`, widen the window, or search a broader term
```

Importer failure in TTY sync:

```text
prosa sync · local store
────────────────────────────────────────────────────────────────────────
found          codex 48 · claude-code 41 · cursor 7 · gemini 0

→ local        importing  63 / 96 · imported 31 · skipped 31 · errors 1 · 24s · eta 12s
· remote       pending
  current      claude-code · …/projects/prosa/session-b.jsonl

errors
  cursor       …/chats/2026-05-29/session-c.jsonl
               parse message: missing timestamp
```

Project not detected:

```text
prosa · local · project not detected · showing all projects

Today
│ 16:31  prosa  laptop  codex  "design CLI output docs"
│        └ 41min · read, write, rg
```

Fatal command error:

```text
error: raw file missing: /Users/upsetbit/.local/share/prosa/raw/codex/2026/05/session.jsonl
```
