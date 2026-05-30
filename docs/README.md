# Docs: prosa

Operational manual for the prosa project. The product philosophy and
direction live at the repo root, in [`../INTENT.md`](../INTENT.md). The
short-horizon work queue is in [`../ROADMAP.md`](../ROADMAP.md). The known
trade-offs we've explicitly accepted are in
[`../TECH_DEBT.md`](../TECH_DEBT.md).

This `docs/` tree is the **how**. INTENT is the **why**.

## Hierarchy of truth

When two documents disagree, the higher one in this list wins:

1. **[`../INTENT.md`](../INTENT.md)** — philosophy, scope, trade-offs.
   Decides whether something *should* exist.
2. **[`../README.md`](../README.md)** — entry point and navigation.
3. **`docs/`** — operational manual (this tree).
4. **[`../AGENTS.md`](../AGENTS.md)** — short repo guide for contributors and
   AI agents, pointing back into INTENT and `docs/`.
5. **`.codex/` and `.claude/`** — specialist subagents, skills, prompts.

`docs/` never contradicts INTENT. If it does, INTENT wins and `docs/` needs
to be updated.

## Map

```
docs/
├── README.md                 you are here — index and hierarchy
│
├── install.md                end-user install across channels
├── usage.md                  CLI tutorial + complete command reference
├── self-hosting.md           server + panel deployment for owners
├── concepts.md               session lifecycle, identity, MVP scope
├── contributing.md           code conventions + adding an importer
├── agents.md                 AI agent orientation, decision checklist
│
├── architecture/             how the code is really structured
│   ├── README.md             architecture index + three-binary overview
│   ├── cli.md                CLI internals
│   ├── server.md             server internals + env vars
│   ├── panel.md              panel internals
│   ├── importers.md          plugin interface
│   ├── store.md              SQLite + raw layout + sync_state
│   └── canonical-session.md  the contract every importer must satisfy
│
├── cli/                      CLI surface design (what the CLI looks like)
│   ├── README.md
│   ├── design-brief.md
│   ├── motion.md
│   ├── rendering-contract.md
│   └── screens.md
│
├── panel/                    web panel design (what the panel looks like)
│   ├── README.md
│   ├── design-brief.md
│   ├── screens.md
│   ├── components.md
│   └── mock-prompts.md
│
├── sources/                  per-agent JSONL formats
│   ├── README.md
│   ├── claude-code.md
│   └── codex.md
│
└── distribution/             how prosa ships
    ├── README.md
    ├── homebrew.md
    ├── npm.md
    ├── install-sh.md
    ├── docker.md
    └── release.md
```

## Who reads what

**End user** (you just want to use prosa):
1. [`../README.md`](../README.md) → [`install.md`](install.md) → [`usage.md`](usage.md).
2. If something looks wrong: [`../TECH_DEBT.md`](../TECH_DEBT.md) and the
   [GitHub issues](https://github.com/c3-oss/prosa/issues).

**Owner self-hosting** the server + panel:
1. [`self-hosting.md`](self-hosting.md) → [`architecture/server.md`](architecture/server.md).
2. [`distribution/docker.md`](distribution/docker.md) for the image.

**Contributor** (you want to change code):
1. [`../INTENT.md`](../INTENT.md) end-to-end first.
2. [`contributing.md`](contributing.md) for conventions.
3. [`architecture/README.md`](architecture/README.md) for the lay of the
   land, then the specific lane you're touching.

**Maintainer** cutting a release:
1. [`distribution/release.md`](distribution/release.md) — the runbook.
2. [`distribution/{homebrew,npm,install-sh,docker}.md`](distribution/) for
   the per-channel detail.

**AI agent** (yes, you):
1. [`../INTENT.md`](../INTENT.md).
2. [`../AGENTS.md`](../AGENTS.md).
3. [`agents.md`](agents.md) for the full orientation.

## Updating these docs

- A code change that alters a public surface (CLI command, proto, schema)
  must update the matching `docs/` page in the same PR.
- A doc change that contradicts INTENT must update INTENT explicitly, or it
  is wrong.
- Quote real paths, real commands, real configuration. If you can't grep it
  out of the repo, don't write it down here.
- Markdown rendered by GitHub. No site generator, no preprocessor.
