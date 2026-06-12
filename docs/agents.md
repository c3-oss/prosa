# For AI agents

You're an AI agent working in the prosa repo. This file orients you so the
work you produce fits the project. It complements [`../AGENTS.md`](../AGENTS.md)
(short operational guide) and [`../INTENT.md`](../INTENT.md) (the
philosophy).

## Hierarchy of truth

When two documents disagree, the higher one wins:

1. **[`../INTENT.md`](../INTENT.md)** — direction, scope, trade-offs.
2. **[`../README.md`](../README.md)** — entry point.
3. **[`README.md`](README.md)** + the rest of `docs/` — operational manual.
4. **[`../AGENTS.md`](../AGENTS.md)** — short repo guide.
5. **`.codex/` and `.claude/`** — specialist subagents, skills, prompts.

If your work needs to override INTENT to make sense, you're proposing a
direction change. Surface that explicitly; don't do it silently.

## Decision checklist

Before you write a single line of code or markdown:

1. **Did you read [`../INTENT.md`](../INTENT.md) end-to-end?** It is short
   on purpose. Don't skim.
2. **Does this change make the central question easier to answer?** The
   central question is *"what did I work on in the last N days?"* with its
   natural follow-ups (where, how, with which agents/models/tools, taking
   how long, costing roughly what). If the answer is no, you are wandering.
3. **Does this preserve INTENT § *In scope (MVP)*?** Don't quietly remove
   things.
4. **Does this touch INTENT § *Out of scope, intentionally*?** If yes, you
   owe an explicit reason and probably a direction-change conversation.
5. **Does this fit INTENT § *How I think when I code*?** Stdlib first.
   Three call sites or it's not a helper. No premature abstraction. No
   feature flags where a delete would do.

If any of those answers is uncomfortable, write the discomfort down
before writing the code. Discomfort is usually the right design feedback.

## Per-area starting points

### Importers

- Read [architecture/importers.md](architecture/importers.md).
- Read [architecture/canonical-session.md](architecture/canonical-session.md)
  — the contract every importer must satisfy.
- Read the relevant [sources/<agent>.md](sources/) for source format.
- Skill: `.codex/skills/prosa-importer-session/SKILL.md`.
- Specialist agent: `prosa-importer-reviewer`.

### CLI

- Read [architecture/cli.md](architecture/cli.md).
- Read [cli/](cli/) — design brief, motion, rendering contract, screens.
- Skill: `.codex/skills/prosa-cli-rendering/SKILL.md`.
- Specialist agent: `prosa-cli-ux-reviewer`.

### Server

- Read [architecture/server.md](architecture/server.md).
- Skill: `.codex/skills/prosa-dev-workflow/SKILL.md`.
- Specialist agent: `prosa-architect` (no separate server reviewer).

### Panel

- Read [architecture/panel.md](architecture/panel.md).
- Read [panel/](panel/) — design brief, screens, components, mock prompts.
- Skill: `.codex/skills/prosa-panel-rendering/SKILL.md`.
- Specialist agent: `prosa-panel-ui-reviewer`.

### Store + sync

- Read [architecture/store.md](architecture/store.md).
- Read [concepts.md#push-only-sync](concepts.md#push-only-sync).
- Skill: `.codex/skills/prosa-dev-workflow/SKILL.md`.

### Distribution + release

- Read [distribution/](distribution/) (per-channel docs) and
  [distribution/release.md](distribution/release.md) (runbook).
- Prompt: `.codex/prompts/release-check.md`.

### Documentation itself

- Read [README.md](README.md) for hierarchy and audience map.
- Don't write docs the code doesn't support.
- Specialist agent: `prosa-docs-reviewer`.

## Choosing simplicity over complexity

Default to the smaller move. Concrete rules:

- **No new dependency** without a paragraph explaining what stdlib code it
  replaces. If you can't write that paragraph, don't add it.
- **No new abstraction** until three call sites need it. Two is coincidence.
- **No new config knob** to handle an imagined case. Add it the day a real
  call site needs it.
- **No new file** when an existing file in the same lane would carry the
  change without becoming worse.
- **No new doc** when an existing doc has room.
- **No feature flag** where a delete would do.
- **Trust the framework / library / OS** at the boundary. Only validate
  what comes from the user.

When you find yourself wanting a registry, a strategy interface, a plugin
loader, an event bus, or a "future-proof" abstraction — push back on
yourself.

## Avoiding bloat

Bloat in prosa looks like:

- Adding DuckDB / Parquet / a columnar sidecar because "analytics".
- Adding a config file for something that has one sensible default.
- Adding a CLI flag for something that's already in another flag.
- Adding a documentation file that summarizes another documentation file.
- Adding an interface that has one implementation.
- Adding a benchmark for hot loops that aren't hot.
- Adding a test that re-asserts what the type system already enforces.
- Adding a migration that "prepares the schema" for an out-of-scope feature.

If you catch yourself, delete the change and write a smaller one.

## Specialist agents

Each subagent below has both `.codex/agents/<name>.toml` and
`.claude/agents/<name>.md` mirrors. They share scope; the format differs.

| Agent | Scope | Writes code? | Read first |
| --- | --- | --- | --- |
| `prosa-architect` | Cross-package design, proto, store, CLI, server, panel boundaries | yes | INTENT, dev-workflow skill |
| `prosa-cli-ux-reviewer` | CLI behavior, flags, terminal rendering, JSON output | no | cli-rendering skill, INTENT |
| `prosa-importer-reviewer` | Importer + canonical-session conformance | no | importer-session skill, sources doc for the agent |
| `prosa-panel-ui-reviewer` | Panel templates, HTMX, Alpine, Frappe charts | no | panel-rendering skill, panel design docs |
| `prosa-docs-reviewer` | Drift between docs and code, hierarchy of truth | no | this file, INTENT |
| `prosa-test-runner` | Run the validation suite, report concisely | no | dev-workflow skill |

When in doubt about which to invoke: if you're changing one lane, invoke the
matching reviewer. If you're spanning lanes, invoke `prosa-architect`. If
you're not sure the change passes tests, invoke `prosa-test-runner`.

## Skills

Reusable skills (in `.codex/skills/`):

- **prosa-dev-workflow** — repository orientation, command selection,
  the justfile, stdlib-first defaults.
- **prosa-importer-session** — the canonical session contract, source-format
  expectations, raw preservation, hash idempotency.
- **prosa-cli-rendering** — TTY vs plain vs JSON output, color tokens,
  truncation, Bubble Tea fallback for cron.
- **prosa-panel-rendering** — `html/template` + HTMX + Alpine + Frappe
  charts (fed a Go-built JSON spec), no build step, single binary.

## Prompts

Task-shaped prompts (in `.codex/prompts/`):

- **importer-change.md** — checklist when planning or reviewing importer
  work.
- **release-check.md** — pre-tag validation steps.

## What you should never silently do

- Bypass tests or CI (`--no-verify`, `--no-gpg-sign`).
- Force-push to master.
- Edit generated files in `gen/` by hand. Run `just gen`.
- Hardcode `~/.config/prosa` or XDG paths outside `internal/paths`.
- Introduce a build step for the panel (esbuild, vite, npm install). The
  panel is a single binary with embedded assets, by design. (Vendoring a
  prebuilt single-file library like `frappe-charts.min.umd.js` via
  `embed.FS`, the way htmx/alpine are, is fine — that is not a build step.)
- Add a Makefile target. `just` is the canonical task runner.
- Move INTENT or AGENTS without updating every reference.
- Write a documentation page that depends on code that doesn't exist yet.

If you must do any of those, say so first.

## When the work spans lanes

For changes that touch multiple subsystems — for example, a proto edit that
changes the CLI command surface and adds a server-side handler — invoke
`prosa-architect` first. It coordinates the right read-only reviewers
afterwards. Don't chain reviewers manually unless you know what you're
doing.

## When the work is purely documentation

Use `prosa-docs-reviewer` for drift checks. The reviewer compares the docs
you've changed against the code, against INTENT, and against the hierarchy
of truth defined here. It does not write code.

## Settings

`.claude/settings.json` configures Claude Code in this repo:

- `SessionStart` hook surfaces the current MVP boundaries from INTENT so
  every session begins oriented.
- `PreToolUse` hook guards destructive edits to `gen/` (regenerate via
  `just gen` instead).

If you find a hook in your way for a legitimate reason, surface that
rather than disabling it.
