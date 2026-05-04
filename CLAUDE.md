# Claude Notes

Pointer doc for Claude Code agents working in `prosa`.

**Read `AGENTS.md` first** — it is the canonical instruction layer. This file covers only what is specific to Claude Code or to quick orientation.

## Bootstrap

1. `AGENTS.md` — canonical repository rules, project structure, commands, testing, and agent-specific instructions.
2. `docs/gpt-5-pro-response.md` — format intent for bundle, schema, CAS, raw preservation, and derived indexes.
3. Relevant `.codex/skills/*/SKILL.md` files for the subsystem being changed.

`AGENTS.md` is authoritative. If `CLAUDE.md` disagrees with it, follow `AGENTS.md` and reconcile this file in the same change set.

## Claude Code specifics

- Use Claude Code's native subagent feature for delegated lanes when the session policy allows it. Specialists live under `.claude/agents/` mirroring `.codex/agents/`. Do not shell out to `claude` or detached worker processes.
- Skills are **never duplicated**: the canonical home is `.codex/skills/`. Claude Code reads them from that path; do not create copies under `.claude/skills/`.
- Claude Code settings live under `.claude/settings.json`. Hooks are currently empty; keep fail-open hooks there if added later.
- Use `devbox shell` when possible and prefer the repository command surface: `pnpm dev -- <command>`, `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
- Do not edit generated output by hand: `dist/`, `coverage/`, `node_modules/`, and `.devbox/` are generated or external.
- Serialize shared-checkout mutations to one owner: edits, generated output updates, patch application, staging, committing, rebasing, branch switching, and pushing.
- For repository work, use the local checkout. Do not use GitHub API reads as a substitute for inspecting files in this repo unless it is a narrow one-off check.
- Write project guidance in present and future terms: current state, expected behavior, and concrete improvements. Prefer rules, checklists, validation, and automation over narrative history.
- After editing `AGENTS.md`, `.codex/skills/`, `.codex/agents/`, or `.claude/agents/`, update this file if the Claude-facing guidance changes.

## Quick Reference

Canonical command surface:

- `pnpm install` — install dependencies from `pnpm-lock.yaml`.
- `pnpm dev -- <command>` — run the CLI through SWC, for example `pnpm dev -- sessions`.
- `pnpm build` — bundle ESM output and declarations with tsup.
- `pnpm typecheck` — run `tsc --noEmit`.
- `pnpm test` — run the Vitest suite once.
- `pnpm lint` — run Biome checks.
- `pnpm lint:fix` or `pnpm format` — apply automatic formatting and lint fixes.
- `pnpm clean` — remove generated build/test outputs.

Storage layout:

- `src/cli/commands/` — CLI commands.
- `src/core/` — bundle, SQLite schema, CAS, ingest helpers, and domain IDs/types.
- `src/importers/` — Codex, Claude, Gemini, and Cursor importers.
- `src/services/` — search, sessions, export, indexing, and user-facing read/query services.
- `src/mcp/` — MCP server and tools.
- `src/tui/` — Ink TUI surfaces.
- `test/` — Vitest tests, fixtures, and helpers.
- `docs/` — architecture, recovery notes, and implementation plans.
- `.codex/skills/` — canonical local skills.
- `.codex/agents/` and `.claude/agents/` — local specialist subagents.

## High-traffic skills

- `.codex/skills/prosa-dev-workflow/SKILL.md`
- `.codex/skills/prosa-importers/SKILL.md`
- `.codex/skills/prosa-search-export/SKILL.md`
- `.codex/skills/prosa-store-schema-cas/SKILL.md`

`.codex/agents/` (Codex) and `.claude/agents/` (Claude Code) hold local specialist subagents. Skills are not duplicated under `.claude/`.
