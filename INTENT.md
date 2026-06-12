# prosa — INTENT

> The soul of the project. Read this end-to-end before proposing anything
> substantial. Architecture, command surfaces, and distribution flow live in
> `docs/`; this file does not duplicate them, and they do not override it.

---

## Why prosa exists

Almost everything I work on these days runs through an AI coding agent — Claude
Code, Codex, sometimes Cursor or Gemini. Sometimes I'm on my laptop, sometimes
on a remote server, sometimes inside a sandbox VM. Across all of that, my own
work history is **fragmented**: each tool has its own format, its own folders,
its own retention policy, its own opinions about what to keep.

I wanted to answer a simple question without having to dig:

> **What did I work on in the last N days?**

That is the load-bearing question. Everything around it earns its place by
making *that* easier to answer — and the analytics around the work are part of
that, not a separate ambition. Where did I work, on which projects, with which
agents, on which models, using which tools, how long things took, how much they
cost: all of it helps me understand my own work. As long as it fits inside
SQLite locally or Postgres remotely, it is fair game.

What prosa is *not* trying to be is a warehouse-shaped analytics pipeline that
happens to also ship a CLI on top.

prosa exists to make all of that cheap.

---

## The central question rules everything

Every decision in this project gets weighed against the central question and
its natural follow-ups — where, how, with which tools, on which models,
costing roughly what. If a feature, an abstraction, a library, a UI surface, or
a documentation page doesn't help me understand my own work with less friction,
it is a candidate for cutting.

This is not a slogan. It is the constraint that keeps the project from
sprawling. When in doubt, return to it.

---

## What prosa is

- A **work log** for AI-agent sessions.
- **Local-first.** The CLI reads the local store offline by default.
- **Optionally cross-device** through a small personal server you own.
- **Three independent Go binaries** — `prosa` (CLI), `prosa-server` (API),
  `prosa-panel` (web) — sharing one module and one typed contract.
- A small set of **importers** (Claude Code, Codex, more later) that map each
  agent's JSONL into the same canonical session shape.

The name comes from the Portuguese verb *prosear*: to chat, to trade ideas
informally. Prosa lets you have a conversation with your own work history.

---

## What prosa is not

- **Not a chat manager.** prosa doesn't replay or edit conversations. It reads
  what already happened.
- **Not a residential TUI.** The CLI prints and exits. The panel is where
  long-form browsing lives. No `j/k` navigation in the terminal.
- **Not an analytics warehouse.** Analytics live in SQLite locally and
  Postgres remotely, and they earn their place — tokens, models, costs, tools,
  projects all matter. What we avoid is the heavyweight side: no DuckDB, no
  Parquet, no columnar pipelines. If plain SQL can answer the question, it
  does. If it could only fit in a warehouse, we cut it.
- **Not multi-tenant yet.** Single-user, single-owner today. Organizations and
  users are a known post-MVP direction; the schema reflects today's reality,
  not tomorrow's.
- **Not a place that mutates your data.** Raw `.jsonl` from each agent is
  preserved as-is, hash-addressed, never altered. When an agent's source is
  a multi-session container (today: Hermes `state.db`), the raw artifact
  per session is a canonical per-session JSONL projected from that
  container — the only exception, taken because copying the container N
  times has exhausted disk in real installs. Every other agent (one source
  file per session) is preserved byte-for-byte.

---

## Principles

1. **Lean > complete.** New deps and abstractions have to earn their place.
   Standard library first.
2. **Single-user (MVP).** No tenancy, no roles, no impersonation today.
   Organizations and users are a post-MVP direction; we don't pre-bake hooks
   for them.
3. **Push-only sync.** The client computes; the client pushes. The server
   stores and serves. There is no replication back.
4. **Idempotent by hash.** A re-sync of unchanged data is a no-op. Re-syncs are
   always cheap.
5. **Layered store.** Metadata + FTS in the database; raw JSONL preserved on
   the filesystem. Each layer has one job.
6. **Offline-first in the CLI.** The CLI reads the local store by default.
   `--remote` opts into the server.
7. **Three binaries, one module.** The CLI, server, and panel are
   independently deployable but share a single Go module and a single typed
   contract (Connect over Protobuf).
8. **Importer-as-plugin.** Each agent adapter is a small Go package that
   implements one interface and maps onto the same `session.Session` shape.
9. **Trust the server.** I own it; redaction at upload time is out of scope
   for the MVP. TLS protects the wire.

---

## In scope (MVP)

- Three binaries: `prosa`, `prosa-server`, `prosa-panel`.
- Importers for Claude Code and Codex; the plugin interface is ready for more.
- Local store: SQLite + raw JSONL sharded under the prosa data dir.
- Server: Postgres + S3-compatible object storage.
- Single-user auth: PKCE + localhost callback for the CLI; OAuth (GitHub/Google) + an
  owner-email whitelist for the panel.
- Push-only sync, idempotent by sha256.
- Scheduled sync (LaunchAgent / systemd timer) plus ad-hoc `prosa sync`.
- Chronological timeline as the default CLI output (`prosa` with no args).
- Structured filters (`--last`, `--project`, `--device`, `--agent`,
  `--profile`) and FTS5 search.
- Per-agent **profiles**: one agent can be imported from more than one
  location on a device (e.g. several `CODEX_HOME` dirs for different
  accounts). Every agent has a `default` profile; extra ones are configured
  with `prosa profiles` and each session records which profile it came from.
- Auto project scoping from the current working directory when inside a known
  project; `--all` overrides.
- Drill-down: `prosa show <session-id>` prints the preserved raw.
- A fixed set of analytics: `sessions`, `tools`, `errors`, `models`,
  `projects`, plus compact usage views (`heatmap`, `usage`) when they help
  answer how much work happened and roughly what it cost.
- A small, server-rendered web panel for the cross-device view.

---

## Out of scope, intentionally

These are not "missing." They are choices — some forever, some until we earn
them.

- **MCP server.** High-value, possibly post-MVP.
- **Residential TUI.** The panel handles long-form browsing.
- **Export (CSV/Parquet/JSON).** The raw is already on disk; rolling your own
  is fine.
- **Multi-user / multi-tenant — for the MVP.** Single-owner today; the schema
  has no `user_id`. Organizations and users are a known post-MVP direction.
- **Redaction at upload time.** TLS in transit; trust at rest.
- **Pull-down of remote sessions into the local store.** Push-only stays
  push-only.
- **Automatic retention / pruning.** Disk is cheap; explicit cleanup if it
  ever hurts.
- **Cold tier of object storage.** One bucket.
- **Incremental upload by byte range or turn.** Hashing the whole file is
  fast enough.
- **DuckDB / Parquet / columnar sidecars.** SQLite and Postgres cover what we
  need for the analytics we want.

If any of these become real pain, we revisit. Not before.

---

## How I think when I code

When I'm writing prosa, the rules in my head:

- **Reach for the standard library first.** A new dependency must measurably
  beat the code I would have to write without it.
- **Don't pre-abstract.** Three call sites or it's not a helper. One call site
  stays inline.
- **No error boilerplate.** `fmt.Errorf("...: %w", err)` is the wrapping
  idiom. No `pkg/errors`-style ladders.
- **Tests over mocks.** Stdlib `testing` plus `testify/require`. No mocking
  frameworks; if a layer is hard to test without mocks, the layer probably has
  the wrong shape.
- **Logging is `log/slog`.** Default text handler in CLI commands.
- **Filesystem layout via `internal/paths`.** Never hardcode `~/.config/prosa`
  or XDG specifics in arbitrary code.
- **Don't widen a surface for an imagined case.** Widen it the day a real
  call site needs it.
- **Don't add a feature flag where a delete would do.**
- **A small, finished thing is worth more than a large, half-finished one.**
- **Developer guardrails stay repo-local.** Hooks and linters are fine when
  they are pinned in `devbox`, reproducible through `just`, and protect this
  repository without becoming product runtime machinery.

If you are an agent and you find yourself wanting to add a config knob, a
strategy interface, a registry, or a "future-proof" abstraction, push back on
yourself. Show me three call sites or scrap it.

---

## Trade-offs that are intentional

There were two prosas before this one.

**V1** was a TypeScript CLI that indexed local agent histories into a SQLite
store. It worked. The query I wanted was answerable. But every sync wrote a
lot of small files, and the disk footprint grew faster than I liked.

**V2** added the cross-device idea: a remote server with a unified view across
machines. It was, honestly, almost entirely vibe-coded. There was no
architectural pass before implementation; choices accumulated. By the time the
panel was reasonable, V2 was carrying things it didn't need — Parquet
sidecars, DuckDB queries, a content-addressable store, a sync pipeline that
duplicated history on every run. It became slow, fat, and untrustworthy. It
still ran, but each sync was a fight.

**V3** — this Go rewrite — exists to undo that. The first move was deciding
what to *not* carry over: no DuckDB, no Parquet, no CAS. SQLite is enough
locally. Postgres is enough remotely. Push-only is enough; bidirectional
replication was never the point. The rest of the project is a slow
accumulation of small decisions that all defer to that posture: smaller is
better; less is enough; the central question rules.

If at any point this project starts to look like V2 again — a generic
platform, a data warehouse with a CLI sitting on top — something is wrong.

---

## Direction

- **UX direction.** The CLI should look careful and quiet: one-shot output,
  good hierarchy in TTY, plain text in pipes. The panel should look like a
  notebook, not a console — first-screen-of-the-day energy.
- **Architecture direction.** Three binaries, one module, one typed contract.
  The server is a thin Postgres + S3 facade. The CLI is the primary surface
  and reads local by default. The panel is server-rendered HTML with HTMX for
  partial swaps; nothing heavier. (It may vendor a small prebuilt JS library
  — e.g. Frappe Charts, ~19 KB, for animated analytics charts — embedded via
  `embed.FS` like htmx/alpine: still single-binary, still no build step.)
- **Simplicity direction.** When in doubt, stop. The project should not need
  a microservice mesh, a CI matrix that takes twenty minutes, a documentation
  site generator, or a plugin marketplace. If you find yourself reaching for
  any of those, you have wandered.

---

## How to use this document

You're an agent (human or AI) about to propose something — a feature, a
refactor, a dependency bump, a doc edit. Before you write the change:

1. Did you read this whole file? It is short on purpose.
2. Does the change make the central question easier to answer?
3. Does it preserve everything in **In scope**?
4. Does it touch anything in **Out of scope, intentionally**? If yes, you owe
   an explicit reason.
5. Does it fit the posture in **How I think when I code**?

If any of those answers is uncomfortable, write the discomfort down before
writing the code. That discomfort is usually the right design feedback.

For operational details — repository layout, build commands, schemas, source
formats, distribution channels, panel design — see `docs/`. For the working
guide on how to navigate this repo as an agent, see `AGENTS.md` and
`docs/agents.md`.
