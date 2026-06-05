# CLI Motion And Progress

Motion in Prosa exists to answer one question:

> Is this command still doing useful work?

Animations must be compact, bounded, and easy to ignore. They are never the
primary product surface.

## Where Motion Is Allowed

Motion is allowed for:

- `prosa sync`;
- `prosa setup`;
- `prosa login`;
- future long-running import or upload commands.

Motion is not allowed for:

- `prosa`;
- `prosa search`;
- `prosa show`;
- `prosa analytics`.

Read commands render once and exit.

## Progress Model

Interactive progress uses a fixed-height checklist with two phase rows
(local import + optional remote catch-up):

```text
prosa sync · local store
────────────────────────────────────────────────────────────────────────
found          codex 48 · claude-code 41 · cursor 7 · gemini 0

→ local        importing  17 / 96 · imported 12 · skipped 5 · errors 0 · 8s · eta 36s
· remote       pending
  current      codex · …/2026/05/30/session-a.jsonl
```

When local finishes and catch-up runs (completed row shows elapsed only):

```text
✓ local        24s
→ remote       reconciling  12 / 37 · sent 10 · skipped 2 · errors 0 · 4s · eta 8s
  current      remote · sess-9a3c…
```

Required parts:

- title with operation and target;
- separator;
- discovered work counts when available;
- one checklist row per phase (`local`, `remote` when logged in);
- active row marker (`→`); completed row marker (`✓`);
- per-phase verb, fraction, imported/sent, skipped, errors, elapsed, ETA while
  active (`→`); completed rows (`✓`) collapse to elapsed time (remote keeps
  `local N · remote N` when available);
- one `current` line for the active phase only (agent + path);
- bounded error region.

The view must not grow with total work size. A sync touching thousands of files
still uses the same number of lines, apart from the bounded error list.

## Phases

Use short verbs that describe actual work:

- scanning;
- parsing;
- importing;
- preserving;
- indexing;
- uploading;
- configuring;
- waiting;
- complete;
- failed.

The active phase row changes in place. Completed rows stay on screen as `✓`
(checklist grammar, same as setup/login) and show timing only so counters are
not repeated. Final numeric totals appear once in the summary block below.
One blank line separates the shell prompt from the sync header.

## Phase Row Verbs

Use short verbs that describe actual work:

```text
→ local        importing  …
✓ local        24s
→ remote       reconciling …
✓ remote       18s · local 2 912 · remote 2 799
```

Do not rotate whimsical or celebratory copy. Prosa's verbs should be useful
when glanced at quickly.

## Persistent Lines

Persist:

- discovered counts;
- both phase rows (local always; remote when logged in);
- latest bounded errors;
- final summaries.

Update in place:

- active row marker and counters;
- current item;
- elapsed time;
- ETA.

This creates motion without scroll spam.

## Errors During Motion

Errors stay visible while the command continues. Keep the latest five errors.

```text
errors
  cursor       …/chats/2026-05-29/session-c.jsonl
               parse message: missing timestamp
```

The command should finish with a non-zero exit status only when the requested
operation cannot complete. Per-file importer errors can be summarized at the
end while allowing the rest of the import to proceed.

## Cancellation

`ctrl+c` cancels the progress program and releases the terminal. After
cancellation, print one short line to `stderr`:

```text
sync canceled
```

Do not leave alternate-screen artifacts, hidden cursors, or partial control
sequences behind.

## Plain And Script Mode

Plain mode is selected when either `stdout` or `stderr` is not an interactive
TTY, or when a verbose/plain flag explicitly requests it.

Plain mode must not use:

- alternate screen;
- cursor movement;
- spinner frames;
- ANSI color;
- animated rewrites.

Plain sync should stream progress and errors as structured logs to `stderr`.
Final summaries may go to `stdout` when they are the command result.

```text
time=2026-05-30T16:31:22-03:00 level=INFO msg=imported agent=codex session=codex-2026-05-30-1342 status=done legacy=false dur=41ms
time=2026-05-30T16:31:22-03:00 level=INFO msg=imported agent=claude-code session=claude-2026-05-29-2118 status=skipped legacy=false dur=12ms
Live:    imported 44, skipped 51, errors 1
```

## Setup And Login Motion

Setup and login use a short checklist. One step may be active at a time.

```text
prosa setup
cwd    /Users/upsetbit/Projects/c3/c3-oss/prosa
store  ~/.local/share/prosa

✓ device       laptop · darwin/arm64
✓ server       https://prosa.c3.do
→ auth         waiting for browser approval
```

The active marker changes to a check when complete. The command exits after the
last step and prints the final state.

## Resize Behavior

Progress must tolerate terminal width changes.

When width shrinks:

- truncate paths from the left;
- preserve phase, counters, and error count;
- drop optional discovered-count details before dropping current item context;
- never wrap spinner/status lines into unreadable blocks.

When width grows, restore detail on the next frame.

## Performance Constraints

Rendering must be independent of total work size. The progress view should be
computed from counters, the current item, and a bounded error list.

Long paths are truncated from the left so the session id or filename remains
visible:

```text
…/2026/05/30/session-a.jsonl
```

