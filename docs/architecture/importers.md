# Architecture: importers

Each AI coding agent prosa supports has its own importer. They share one
interface and produce the same canonical session shape.

For the contract every importer must satisfy, see
[canonical-session.md](canonical-session.md). For per-agent source format
details see [`../sources/`](../sources/).

## The interface

In `pkg/importer/importer.go`:

```go
type Importer interface {
    Name() string
    DefaultRoots() []string
    Walk(ctx context.Context, root string) ([]string, error)
    Import(ctx context.Context, jsonlPath string, sink Sink, opts ImportOptions) (ImportResult, error)
}

type Sink interface {
    WriteSession(ctx context.Context, s session.Session, tools []session.ToolUsage, turns []session.Turn, hash string) error
    LastHash(ctx context.Context, sessionID string) (string, bool, error)
}

type SkipCache interface {
    LastImportSkip(ctx context.Context, sessionID, reason string) (string, bool, error)
    RecordImportSkip(ctx context.Context, sessionID, hash, reason string) error
}
```

- **`Name()`** — short agent key (`"claude-code"`, `"codex"`, etc.). Used
  as the directory shard for raw files and as the `agent` field in
  sessions.
- **`DefaultRoots()`** — the per-platform roots `prosa sync` should walk
  by default (e.g. `~/.claude/projects/`). These are suggestions; users
  can override (planned).
- **`Walk(ctx, root)`** — find candidate session files under `root`,
  returning their absolute paths. Walk is allowed to filter (e.g. skip
  files with the wrong extension or in the wrong subdirectory).
- **`Import(ctx, jsonlPath, sink, opts)`** — open the file, hash it,
  decide whether to no-op, parse it, classify its usage, and write into
  the sink. `opts.Overwrite` bypasses the idempotency short-circuit and
  the no_usage skip cache (used by `prosa sync --overwrite`).

The `Sink` is implemented by `internal/store` (locally) and by an in-memory
fake for tests. Importers never know about SQLite, Postgres, or the server.
`SkipCache` is an optional `Sink` extension used for policy skips that do
not create a session row.

Importers that project one source file into one session should route their
`Import` implementation through `internal/importers/importerutil.RunSingleFile`.
That helper owns the shared hash/idempotency/skip/preserve/write sequence;
the per-agent package supplies only `hashAndSize`, `peekSessionID`,
`parseSession`, and `preserveRaw`. Hermes `state.db` remains bespoke because
one source file can produce many sessions — and because the raw artifact
for each of those sessions is a per-session JSONL projected from the
`messages` rows (via `importerutil.PreserveProjectedJSONL`), not the
multi-session `.db` file. See `docs/sources/hermes.md` for the projection
contract and issue #235 for the disk-exhaustion failure mode that drove
the projection.

## Idempotency contract

An importer must:

1. Compute `sha256(raw)` before doing any parse work.
2. **When `opts.Overwrite` is false:** ask `sink.LastHash(ctx, sessionID)`.
   If the result equals the current hash, return immediately with a no-op
   `ImportResult`.
3. **When `opts.Overwrite` is false:** ask `SkipCache` whether this same
   `(session_id, reason, hash)` was previously policy-skipped. For ordinary
   transcript files, `session_id` is the real agent session id and the
   reason is `no_usage`; for Hermes `state.db` rows that are shadowed by a
   sibling transcript, `session_id` is a synthetic
   `hermes-state-<hash[:12]>` marker with reason `state_seen`. Do not assume
   `import_skips.session_id` joins to `sessions.id` without checking the
   reason.
4. Parse the file and obtain a `session.UsageState` from the parser. Call
   `importpolicy.ClassifyForImport(state)`:
   - `DecisionSkipNoUsage` (state is `UsageStateExplicitZero`, i.e. the
     parser observed a usage event whose totals were all zero) → record a
     `no_usage` policy skip and return without writing the session, turns,
     tools, raw copy, or sync hash.
   - `DecisionAdmit` (state is `UsageStatePresent` or `UsageStateUnknown`)
     → continue.
5. Call `sink.WriteSession(ctx, sess, tools, turns, hash)`. The sink
   persists the session row, tool usage, turns, and the sync hash in a
   single transaction, so a crash mid-import can never leave a session row
   without its turns or with a stale sync hash.

Steps 2 and 3 are the only ones bypassed by `--overwrite`; step 4's
classification still applies because we only want to keep sessions whose
authors meant for them to be tracked.

There is **no per-turn incremental sync**. A new hash always means "full
re-import of this session." Hashing the whole file is fast enough; this
keeps importer code simple.

Side effects an importer must perform:

- **Preserve the raw** — copy the source `.jsonl` byte-for-byte into
  `paths.RawRoot(agent)/<YYYY>/<MM>/<session-id>.jsonl`. The hash must
  match what was on disk.
- **Never alter the source** — prosa does not delete, rename, or rewrite
  the agent's files.

## Mapping into canonical session

For each session file an importer extracts:

```go
session.Session{
    ID:             // agent-assigned, stable across re-imports
    Agent:          // importer.Name()
    DeviceID:       // device.IDOnce() — passed in via context
    ProjectPath:    // cwd if discoverable, else nil
    ProjectRemote: // git remote of cwd if a git repo
    ProjectMarker: // .prosa.yaml project: field if present
    StartedAt:      // first record's timestamp (UTC)
    LastActivityAt:// most recent record's timestamp (UTC)
    FirstPrompt:    // first user turn, truncated to ≤200 runes
    Model:          // first model encountered in the JSONL
    RawPath:        // paths.RawRoot(agent) + computed filename
    RawHash:        // sha256 of source bytes
    RawSize:        // bytes
}
```

Plus:

- `session.TokenUsage` — aggregate token usage. Sessions without any
  positive token field are skipped by import policy.
- `[]session.Turn` — every user/assistant turn (text content only), in
  source order. Tool calls and tool results are NOT included in turns in
  the MVP cut — they're preserved in raw but not indexed.
- `[]session.ToolUsage` — `name → count` aggregation per session.

The exact `session.Session` definition is in `pkg/session/types.go`. The
canonical contract is [canonical-session.md](canonical-session.md).

## Project identity inside the importer

If the importer can determine the cwd from the session file (Claude Code
puts it in the path; Codex stores it in `session_meta`), it tries to
resolve project identity in this order:

1. **Git remote** — `git remote get-url origin` from cwd.
2. **`.prosa.yaml` marker** — cwd or any ancestor.
3. **Fallback** — leave `ProjectPath` set and the other two nil.

The resolution helpers live in `internal/cli/projectid.go` (shared with
the timeline auto-scoping logic). Importers call them — they don't re-roll
the lookup.

## Currently registered importers

Listed in `internal/cli/sync.go`:

| Agent | Package | Default root |
| --- | --- | --- |
| `claude-code` | `internal/importers/claudecode/` | `~/.claude/projects/` |
| `codex` | `internal/importers/codex/` | `~/.codex/sessions/` |
| `cursor` | `internal/importers/cursor/` | `~/.cursor/chats/` |
| `gemini` | `internal/importers/gemini/` | `~/.gemini/tmp/` |
| `antigravity` | `internal/importers/antigravity/` | `~/.gemini/antigravity-cli/conversations/` |
| `hermes` | `internal/importers/hermes/` | `~/.hermes/sessions/` |

For per-agent source format details, see [`../sources/`](../sources/).

## Adding a new importer

The contributing guide covers the full procedure:
[`../contributing.md#adding-a-new-importer`](../contributing.md#adding-a-new-importer).

The short version:

1. Document the source format in `docs/sources/<agent>.md`.
2. Create `internal/importers/<agent>/`. Mirror the shape of
   `internal/importers/claudecode/`.
3. Implement `Walk` and `Import`. Be paranoid about malformed records and
   partial files.
4. Write parser tests (`parse_test.go`) covering representative records,
   missing fields, malformed JSON, truncated files, sessions with no
   turns.
5. Register the new importer in `internal/cli/sync.go`'s importer slice.

Run before opening a PR:

```sh
just test ./internal/importers/<agent>/... -race
just test ./internal/store/... -race
just ci
```

## Reviewer focus

The `prosa-importer-reviewer` agent (read-only) checks importer changes
against:

1. Canonical-session mapping still holds.
2. Source-format assumptions match `docs/sources/<agent>.md`.
3. Session IDs, timestamps, project context, tools, first prompt, raw paths
   stay stable across re-imports.
4. Idempotency is hash-based and avoids per-turn diffing.
5. Parser tests cover representative + malformed records.

Skill backing the reviewer:
`.codex/skills/prosa-importer-session/SKILL.md`.

## What importers must not do

- Touch the network. Importers are purely local; sync is the network step.
- Open the store directly. Use the `Sink` interface.
- Drop fields silently because they don't fit the schema. If a useful field
  is missing from the canonical shape, propose a canonical-session edit.
- Special-case a single user. If a behavior is needed, document it in
  `docs/sources/<agent>.md` and put it under a flag if it's optional.
- Mutate the agent's raw files in any way.
