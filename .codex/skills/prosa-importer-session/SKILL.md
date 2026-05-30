---
name: prosa-importer-session
description: Canonical session and importer rules for prosa. Use when changing pkg/session, pkg/importer, docs/architecture/canonical-session.md, or any internal/importers/<agent> implementation.
---

# Prosa Importer Session

Use this skill before changing an importer or the canonical
`session.Session` mapping.

## Canonical contract

`docs/architecture/canonical-session.md` is authoritative. Every importer
must map its source JSONL into `pkg/session.Session` with stable
metadata, normalized turns, tool calls, timestamps, project context, and
raw preservation.

The importer interface lives in `pkg/importer`:

- `Name()` returns the stable agent key (`claude-code`, `codex`,
  `cursor`, `gemini`).
- `DefaultRoots()` returns source directories to scan.
- `Walk(ctx, root)` discovers source files without importing them.
- `Import(ctx, path, sink)` parses one source file and writes through
  the `Sink` abstraction (defined in `pkg/importer/importer.go`).

The plugin interface is documented end-to-end in
`docs/architecture/importers.md`.

## Source references

Read the relevant source-format doc before editing parser behavior:

- `docs/sources/claude-code.md` for Claude Code JSONL.
- `docs/sources/codex.md` for Codex session JSONL.
- `docs/sources/README.md` for the structure every per-agent doc must
  follow.

Use an analogous importer as the default shape for new agents — see
`internal/importers/claudecode/` for a complete model.

## Raw preservation

The local store keeps one raw `.jsonl` per session under the prosa data
dir (`paths.RawRoot(agent)/<YYYY>/<MM>/<session-id>.jsonl`). Do not rely
on the original agent file remaining on disk. Importers preserve the
original bytes byte-for-byte; the store owns lookup by session metadata.

The raw hash recorded by the importer must match what was on disk.
Atomic file write (write to temp, fsync, rename) is the expected pattern.

## Idempotency

Imports are hash-based:

1. Compute `sha256(raw)` before any parse work.
2. Ask `sink.LastHash(ctx, sessionID)`.
3. If the hash matches, return a no-op `ImportResult`.
4. Otherwise, parse, upsert, write turns, write tool usage, and call
   `sink.RecordSync` with the new hash.

There is **no per-turn incremental sync**. A new hash means full
re-import of that session. Hashing the whole file is fast enough.

## Project identity

If the source format gives you the session's cwd, resolve project
identity in this order (helpers in `internal/cli/projectid.go`):

1. `git remote get-url origin` from cwd.
2. `.prosa.yaml` marker file in cwd or any ancestor.
3. Cwd path as fallback.

Don't re-implement this resolution; call the shared helpers.

## Testing

Importer changes need focused parser/walk tests. Cover:

- Stable session ID extraction.
- First user prompt / title behavior.
- Timestamp parsing and last-activity behavior.
- Tool-call extraction where the source format supports it.
- Malformed or partial lines that should be skipped or reported.
- Hash/idempotency behavior at the sink/store boundary when touched.

Run focused tests first, then `just test-race`:

```bash
go test ./internal/importers/<agent>/... -race
go test ./internal/store/... -race
just test-race
```

## See also

- `docs/architecture/importers.md` — plugin interface, idempotency
  contract, raw preservation, adding a new importer.
- `docs/architecture/canonical-session.md` — the canonical session shape.
- `docs/sources/` — per-agent source-format docs.
