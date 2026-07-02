# Prosa CLI Design

This directory defines the output design contract for the `prosa` CLI.

The CLI exists to answer one question quickly:

> What did I work on in the last few days?

The interface should feel like a quiet command surface: dense, readable,
scriptable, and carefully paced. Prosa should borrow the polish of modern
agent CLIs without adopting their resident chat UI shape.

## Design Direction

Prosa is not a terminal app that stays open. It is a set of commands that run,
print well-structured output, and exit.

The right feel is:

- fast local recall;
- calm hierarchy;
- compact status;
- stable columns;
- short messages;
- precise progress;
- zero decorative noise.

Modern agent CLIs are useful references for craft:

- Charmbracelet-style terminal primitives: restrained color, spinners, tables,
  rails, and spacing.
- Codex-style automation discipline: progress and diagnostics separated from
  final command output.
- Claude Code-style status awareness: concise context, session identity, and
  useful activity verbs.
- Cursor-style environment context: cwd, project, branch, and mode surfaced
  early without dominating the screen.

These are references, not patterns to clone. Prosa read commands remain
one-shot renderers.

## Reference Inputs

- Charmbracelet Gum: compact shell-script UI primitives, including spinners,
  tables, styling, and structured logs.
  <https://github.com/charmbracelet/gum>
- Charmbracelet Crush: terminal-first agent polish, session awareness, and
  status-heavy developer workflows.
  <https://github.com/charmbracelet/crush>
- OpenAI Codex CLI: interactive terminal UI separated from scriptable
  non-interactive mode.
  <https://developers.openai.com/codex/cli>
- OpenAI Codex non-interactive mode: progress on `stderr`, final output on
  `stdout`, and JSONL for automation.
  <https://developers.openai.com/codex/noninteractive>
- Claude Code CLI: print mode, JSON/stream-JSON output, status lines, color,
  and spinner verb customization.
  <https://code.claude.com/docs/en/cli-reference>
- Claude Code terminal configuration: theme selection and terminal color
  compatibility.
  <https://code.claude.com/docs/en/terminal-config>
- Claude Code status line: semantic color usage for status, git, and context
  information.
  <https://code.claude.com/docs/en/statusline>
- Cursor CLI: terminal/headless split, environment context, and resize/truncate
  behavior for agent terminal surfaces.
  <https://cursor.com/en-US/cli>

## Output Anatomy

Human TTY output should usually follow this shape:

```text
context line

group header
  content row
    supporting row

summary or hint
```

The context line is optional and belongs on `stderr` when it describes scope,
source, warnings, or diagnostics. Command data belongs on `stdout`.

Examples of context lines:

```text
prosa · local · scoped to c3-oss/prosa · last 7d
prosa · local · all projects · last 30d
search · local · scoped to c3-oss/prosa · "sqlite"
```

Use the context line to remove ambiguity. Do not turn it into a banner.

## Color Scheme

Prosa should use a soft semantic palette, closer to modern agent CLIs than to
traditional bright ANSI dashboards. Primary text should usually be the
terminal's default foreground. Color is for structure, identity, and state.

The palette should feel muted on dark terminals and still legible on light
terminals:

- no pure ANSI red, green, yellow, cyan, or blue for normal UI;
- no large saturated blocks;
- no rainbow agent identity system;
- no color-only meaning;
- no bold red search snippets unless the terminal is already high-contrast.

Recommended tone:

```text
foreground  default terminal foreground
muted       soft gray
rail        low-contrast gray
accent      desaturated blue
device      soft blue-cyan
agent       muted amber
project     sage green
success     sage green
warning     muted amber
error       soft rose
match       muted amber, underline or bold
```

When truecolor is available, use the hex palette in the rendering contract. For
256-color terminals, use the nearest xterm indices. When color support is weak,
fall back to default foreground, bold, underline, and spacing.

## Command Surfaces

`prosa` renders a recent work timeline. It is optimized for scanning by day,
project, agent, and prompt.

`prosa search` renders evidence blocks. Each result should answer: where was
this match, who said it, and why is it relevant?

`prosa sync` is the primary animated surface. It should show bounded progress,
current work, errors, and a factual final summary.

`prosa setup` and `prosa login` may use a short checklist flow. They should
feel like configuration commands, not onboarding screens.

`prosa show <session-id>` is an audit command. It must keep raw output easy to
pipe and preserve.

`prosa analytics <report>` is a compact operational table. It should support
comparison, not decoration.

## Terminal Grammar

Allowed structural symbols:

```text
│  ├  └  ─  →  ⤷  ·  *  …
```

Recommended meanings:

- `│` creates a light visual rail for grouped output.
- `├` marks intermediate detail under a row.
- `└` marks the final detail under a row.
- `→` marks the current active step.
- `⤷` marks derived metadata or a snippet.
- `·` separates compact metadata.
- `*` marks an active session.
- `…` is the only truncation marker.

Do not use emoji.

## TTY And Plain Modes

Interactive TTY output may use:

- semantic color;
- day headers;
- left rails;
- responsive truncation;
- compact spinners;
- in-place status updates;
- bounded error blocks.

Plain/script output must use:

- no ANSI escapes;
- no cursor movement;
- no spinners;
- stable rows;
- tab-separated text, structured logs, JSON, or NDJSON depending on command.

When output is piped, redirected, or requested with `--json`, Prosa should
prefer boring and parseable over pretty.

## Stdout And Stderr

`stdout` is for command data:

- timeline rows;
- search result rows;
- raw JSONL;
- analytics rows;
- final summaries;
- JSON/NDJSON streams.

`stderr` is for operational context:

- automatic project scope notices;
- progress;
- warnings;
- importer errors;
- cancellation notices;
- logs.

For automation, this mirrors the useful agent CLI pattern: progress can stream
while the final result remains easy to pipe.

## Non-TUI Boundary

The CLI must not implement these for read commands:

- `j/k` navigation;
- row selection;
- inline drill-down;
- side panels;
- drawers;
- persistent tabs;
- expand/collapse state;
- full-screen layouts.

The web panel owns richer interactivity. The CLI owns fast local recall.
