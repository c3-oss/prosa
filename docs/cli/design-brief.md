# Design brief: prosa CLI

## Context

`prosa` is a CLI for answering, quickly:

> What did I work on in the last few days?

It imports local sessions from AI coding agents — Codex, Claude Code,
Cursor, Gemini — and consolidates them into a single, searchable timeline.
The user is not trying to manage chats; they want to recover work context
fast.

Typical questions:

- What did I do yesterday in this project?
- Where's that session about SQLite?
- Which agent did I use to solve that problem?
- Which machine was it on?
- I want to see the raw history of that session.

## Central direction

The prosa CLI should feel **minimal, elegant, and pleasant**.

Minimal does not mean raw. It means every element justifies its presence.
The interface should look cared-for, with good hierarchy, good visual
rhythm, and little ornamentation.

Elegant, here, means:

- fast to read;
- consistent alignment;
- contrast with purpose;
- predictable truncation;
- short, precise messages;
- well-resolved empty states;
- clear progress on long-running commands;
- good behavior in narrow terminals.

## Not a TUI

The goal is **not** to turn `prosa` into a TUI.

We don't want a permanent interactive application living inside the
terminal. No `j/k` navigation, no row selection, no side panels, no
interactive tabs, no expand/collapse, no drawers, no inline drill-down, no
resident state.

The goal is a **beautiful, pleasant CLI**: commands that run, print an
excellent output, and exit.

Examples:

- `prosa` prints a timeline and exits.
- `prosa search "sqlite"` prints results and exits.
- `prosa sync` may show animated progress while it works, but ends with a
  summary.
- `prosa setup` may be a short wizard, but doesn't become a terminal app.

Think **output design for CLI**, not TUI product.

## Visual language

The CLI can and should use Unicode characters well, when they help create
hierarchy, flow, or feedback.

Good usage families:

- arrows and connectors: `→`, `↳`, `⤷`;
- light separators: `─`, `│`, `·`;
- truncation ellipsis: `…`;
- discreet markers: `*`, `•`;
- spinners on long commands: `⠋`, `⠙`, `⠹`, `⠸`, `⠼`, `⠴`, `⠦`, `⠧`,
  `⠇`, `⠏`;
- short textual progress, without graphic excess.

Absolute rule: **zero emojis**.

Don't use emojis for status, celebration, error, progress, empty, or
decoration. If a symbol is needed, use textual/terminal-friendly Unicode
that doesn't look like an emoji.

## Principal surface

The principal experience is the terminal. It must work well both for
humans and for scripts.

Requirements:

- beautiful output on TTY;
- no ANSI/color when used with pipe or redirect;
- good readability at 80 columns;
- responsive truncation;
- stable alignment;
- color with function, not decoration;
- JSON/plain output when needed;
- logs off `stdout` when `stdout` carries the command's result.

## Flows that need to be designed

### 1. Timeline: `prosa`

Shows recent sessions; default window is the last 7 days.

The principal line should communicate:

- time;
- whether the session is still active;
- device;
- agent;
- project;
- the first user prompt;
- duration;
- main tools used.

When the user runs `prosa` inside a known project, the CLI auto-scopes to
that project. That scope must appear discreetly and clearly, probably on
`stderr` in the human output.

Conceptual example:

```text
scoped to prosa · use --all for every project

Today
  11:24  laptop   claude-code  prosa       "refactor sync logic"
         ⤷ 32min  edit, bash

  09:02* laptop   codex        prosa       "setup importer tests"
         ⤷ 18min  write, grep
```

### 2. Global timeline: `prosa --all`

Shows sessions across all projects. The challenge is density: many
projects, agents, and devices without becoming visual noise.

The design has to show how to preserve scanability when there are:

- long project names;
- agents with different lengths;
- different devices;
- active sessions;
- long prompts;
- multiple grouped days.

### 3. Search: `prosa search "query"`

Searches session content.

Each result must show:

- related session;
- project;
- agent;
- device;
- date/time;
- found excerpt;
- match highlight;
- the excerpt's role (`user` or `assistant`).

The highlight must be perceptible without being loud. On TTY, color or
bold are fine. In plain output, it should become clean text or a
predictable marker.

### 4. Sync: `prosa sync`

Imports sessions from the local agents.

Expected flow:

- scan directories;
- detect new or modified files;
- import sessions;
- skip sessions already seen;
- preserve raw;
- end with a summary.

In interactive mode, animation is welcome. The animation should be small,
useful, and quiet: spinner, in-place updated lines, counters, phases. No
full-screen takeover.

Tone example:

```text
sync
  ⠹ scanning codex        ~/.codex/sessions
  · claude-code           42 found
  · cursor                8 found

importing
  → codex        2026-05-30/session-a.jsonl
  → claude-code  2026-05-29/session-b.jsonl

summary
  imported 12 · skipped 38 · errors 0
```

In non-interactive mode, the output has to be clean, structured text/log,
without ANSI and without animation.

## 5. Show raw: `prosa show <session-id>`

Prints the preserved raw JSONL.

This is not the editorial reading surface. It's the audit surface. Even
so, the command must make clear:

- which session is being shown;
- which agent it came from;
- where the raw was preserved;
- that the content below is the original source.

### 6. Setup/login: `prosa setup` / `prosa login`

First-time configuration flow:

- identify the device;
- open a browser for authentication;
- approve on the server;
- save the local token;
- configure periodic sync.

A short wizard, with clear steps and discreet checks. Even so, it should
not look like a permanent interactive app.

### 7. Analytics: `prosa analytics <report>`

Fixed reports:

- `sessions`;
- `tools`;
- `errors`;
- `models`;
- `projects`.

The output should be tabular, dense, operational. Avoid decorative
dashboards. The focus is rapid comparison.

## Mocks requested

I want **8 different mocks**, focused on information structure and output
behavior, not on visual themes.

Each mock should represent exactly what the command prints before exiting.

1. `prosa` with auto-detected project.
2. `prosa --all` with many sessions.
3. Timeline in a narrow terminal, roughly 80 columns.
4. `prosa search "query"` with multiple results.
5. `prosa sync` in interactive mode with progress/animation.
6. `prosa sync` in plain/script mode.
7. `prosa setup` or `prosa login` as a short wizard.
8. Empty states and errors: no sessions, no results, importer failing,
   project not detected.

When it makes sense, each mock should show two versions:

- a human version for interactive terminal;
- a plain version for pipe/script.

## Expected result

The ideal prosa CLI should look like a small, very well-finished tool.

It doesn't need to impress through complexity. It needs to convey
confidence: I ran the command, I understood the scope, I saw what
mattered, I found what I wanted — and the output is still good when I copy
it, redirect it, or use it in a script.
