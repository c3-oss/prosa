---
name: prosa-importer-session
description: Canonical session and importer rules for prosa. Use when changing pkg/session, pkg/importer, docs/canonical-session.md, or any internal/importers/<agent> implementation.
---

# Prosa Importer Session

Use this skill before changing an importer or the canonical
`session.Session` mapping.

## Canonical contract

`docs/canonical-session.md` is authoritative. Every importer must map its
source JSONL into `pkg/session.Session` with stable metadata, normalized
turns, tool calls, timestamps, project context, and raw preservation.

The importer interface lives in `pkg/importer`:

- `Name()` returns the stable agent key (`claude-code`, `codex`, etc.).
- `DefaultRoots()` returns source directories to scan.
- `Walk(ctx, root)` discovers source files without importing them.
- `Import(ctx, path, sink)` parses one source file and writes through the
  `Sink` abstraction.

## Source references

Read the relevant source-format doc before editing parser behavior:

- `docs/sources/claude-code.md` for Claude Code JSONL.
- `docs/sources/codex.md` for Codex session JSONL.

Use an analogous importer as the default shape for new agents.

## Raw preservation

The local store keeps one raw `.jsonl` per session under the Prosa data dir.
Do not rely on the original agent file remaining on disk. Importers should
preserve the original bytes and let the store own lookup by session metadata.

## Idempotency

Imports are hash-based. A file with an unchanged raw hash should skip without
rewriting turns. A changed file should replace/update the local session view
from the full raw file; do not implement byte-range or turn-level incremental
sync in the MVP.

## Testing

Importer changes need focused parser/walk tests. Cover:

- Stable session ID extraction.
- First user prompt / title behavior.
- Timestamp parsing and last-activity behavior.
- Tool-call extraction where the source format supports it.
- Malformed or partial lines that should be skipped or reported.
- Hash/idempotency behavior at the sink/store boundary when touched.

Run focused tests first, then `just test-race`.
