# Architecture: store

The local store. Where session metadata, full-text index, raw transcripts,
and sync state live on disk.

For the **why** behind the layered design see
[`../concepts.md#layered-store`](../concepts.md#layered-store). For the
server-side equivalent see [server.md](server.md).

## Two layers

```
~/.local/share/prosa/                       (overridable via PROSA_HOME)
├── store.db                                SQLite — metadata + FTS
└── raw/
    ├── claude-code/
    │   └── 2026/05/<session-id>.jsonl     raw transcript, byte-identical
    ├── codex/
    │   └── 2026/05/<session-id>.jsonl
    ├── cursor/
    │   └── ...
    └── gemini/
        └── ...
```

- **`store.db`** holds session metadata, the extracted turns for FTS, tool
  usage aggregates, sync state, and the device registry. SQLite in WAL
  mode.
- **`raw/<agent>/<YYYY>/<MM>/<session-id>.jsonl`** is the source-of-truth
  raw text. It's never altered, never listed by directory scan — every
  lookup goes through the store's `raw_path` column.

The raw layer is authoritative for content; the SQLite layer is a
derivable index. Lose the index and the next `prosa sync` rebuilds it from
the server's manifest.

## Paths

Resolved via `internal/paths/`:

- `paths.Home()` → data root.
- `paths.StorePath()` → `Home()/store.db`.
- `paths.RawRoot(agent)` → `Home()/raw/<agent>/`.

`PROSA_HOME` overrides `Home()`. Standard `XDG_DATA_HOME` is honored when
`PROSA_HOME` is not set. No other package should know about these layouts.

## Driver and pragmas

`modernc.org/sqlite` (pure-Go, no CGO). Registered as `sqlite` in
`internal/store/store.go`.

Pragmas set on every writer open (`store.Open`):

- `journal_mode = WAL` — concurrent reads, single writer.
- `foreign_keys = ON` — schema integrity.
- `synchronous = NORMAL` — safe under WAL, faster than `FULL`.
- `busy_timeout = 5000` — ride out brief writer/reader contention
  instead of failing with `database is locked`.

The read-only open path (`store.OpenReadOnly`) is intentionally
different: it adds `mode=ro`, keeps `foreign_keys` + `busy_timeout`,
omits `journal_mode(WAL)` and `synchronous(NORMAL)` (no writes
possible), skips `mkdir` + `migrate`, and bounds the connection pool
to `SetMaxOpenConns(4)` / `SetMaxIdleConns(2)` so a single process
doesn't saturate SQLite's reader serialization. Timeline, search,
show, and analytics use it; sync uses the writer.

Two typed errors back the read-only path:

- `ErrStoreNotInitialized` — file does not exist; CLI prints "run
  `prosa sync` first".
- `ErrStoreNeedsMigration` — embedded migrations include a newer
  version than what's recorded on disk; CLI prints "run `prosa sync`
  or another write command first".

Connections live for the process lifetime. The store is not designed
for many writers; the CLI and the panel never write at the same time
on the same machine.

## Migrations

`migrations/local/` is embedded via `embed.FS`. Files are applied in
order at `store.Open()` time. A `schema_migrations` table tracks what's
applied.

| Migration | What it adds |
| --- | --- |
| `0001_init` | `devices`, `sessions`, `session_tools`, `turns`, `turns_fts` + triggers, `sync_state` |
| `0002_identity` | `sessions.project_remote`, `sessions.project_marker`, `devices.fingerprinted_at` |
| `0003_manifest_index` | composite `(device_id, id)` index on `sessions` for reconcile |
| `0004_usage_projection` | `session_usage` table + `sync_state.projection_version` |
| `0005_turns_evidence` | `turns.kind` (default `'message'`), `turns.tool_name`, indexes on both |

Each migration has an up and down `.sql` file. The store applies up only;
down is for manual recovery.

## Schema (current)

### `devices`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Device fingerprint |
| `hostname` | TEXT | |
| `machine_id` | TEXT | OS-level machine ID |
| `friendly_name` | TEXT | Defaults to hostname; user-editable cross-device |
| `fingerprinted_at` | TEXT | RFC3339 of first registration |

Seeded with one `'local'` row at install. Replaced by the real
fingerprint on first successful `prosa sync` via `RebindLocalSessions`.

### `sessions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Agent-assigned session ID |
| `agent` | TEXT | `claude-code`, `codex`, `cursor`, `gemini` |
| `device_id` | TEXT FK | → `devices.id` |
| `project_path` | TEXT NULL | cwd when discoverable |
| `project_remote` | TEXT NULL | Git remote origin URL |
| `project_marker` | TEXT NULL | `.prosa.yaml project:` value |
| `started_at` | TEXT | RFC3339 UTC |
| `last_activity_at` | TEXT | RFC3339 UTC |
| `first_prompt` | TEXT NULL | Truncated user prompt |
| `model` | TEXT NULL | First model encountered |
| `raw_path` | TEXT | Absolute path to preserved JSONL |
| `raw_hash` | TEXT | sha256 of source bytes |
| `raw_size` | INTEGER | Bytes |

Indexes:

- `idx_sessions_started_at DESC` — timeline default sort.
- `idx_sessions_last_activity DESC` — active-session detection.
- `idx_sessions_project` on `project_path`.
- `idx_sessions_project_remote`.
- `idx_sessions_project_marker`.
- `idx_sessions_agent`.
- `idx_sessions_device_id`.

### `session_tools`

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | TEXT FK | → `sessions.id` |
| `name` | TEXT | Tool name as observed in raw |
| `count` | INTEGER | Number of invocations in this session |
| PK | `(session_id, name)` | |

Index: `idx_session_tools_name`.

### `turns`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | autoincrement rowid |
| `session_id` | TEXT FK | → `sessions.id` |
| `role` | TEXT | `user` \| `assistant` \| `tool` |
| `content` | TEXT | Searchable text; tool outputs land here truncated to a preview (raw stays on disk) |
| `ts` | TEXT | RFC3339 UTC |
| `kind` | TEXT NOT NULL DEFAULT `'message'` | `message` \| `tool_result` \| `operational` |
| `tool_name` | TEXT NULL | Originating tool when `kind = 'tool_result'` |

Indexes: `idx_turns_session`, `idx_turns_kind`,
`idx_turns_tool_name` (partial: `WHERE tool_name IS NOT NULL`).

### `turns_fts` (virtual, FTS5)

```sql
CREATE VIRTUAL TABLE turns_fts USING fts5(
    role,
    content,
    content='turns',
    content_rowid='id',
    tokenize='porter unicode61'
);
```

Maintained by two triggers:

- `turns_ai` — after insert on `turns`, insert into `turns_fts`.
- `turns_ad` — after delete on `turns`, delete from `turns_fts`.

Note: the local FTS uses **porter + unicode61** (stemming). The server's
FTS uses Postgres `simple` (no stemming). Queries against `--remote` may
match slightly differently than the local version.

### `sync_state`

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | TEXT PRIMARY KEY FK | → `sessions.id` |
| `last_hash` | TEXT | sha256 of last successfully pushed raw |
| `last_synced_at` | TEXT | RFC3339 UTC |

The push step compares the current session hash against this value to
decide whether to push.

## Public API (Go)

The store package exposes a `Store` type plus methods. Importers and CLI
commands use it; nobody else writes SQL.

```go
s, err := store.Open(ctx, paths.StorePath())
defer s.Close()
```

Selected functions (full list in `internal/store/`):

| Function | What it does |
| --- | --- |
| `Open(ctx, path)` | Open + migrate (writer; sync/import only) |
| `OpenReadOnly(ctx, path)` | Read-only handle for timeline/search/show/analytics |
| `Close()` | Close the connection |
| `UpsertSession(ctx, sess, tools)` | Insert/replace session + tools in one txn |
| `InsertTurns(ctx, sessionID, turns)` | Append turns (triggers FTS index); persists kind/tool_name |
| `LastHash(ctx, sessionID)` | Read `sync_state.last_hash` |
| `RecordSync(ctx, sessionID, hash)` | Update `sync_state` |
| `GetSession(ctx, id)` | Read one session |
| `GetTurns(ctx, sessionID)` | Read all turns (with kind/tool_name) |
| `GetSessionTools(ctx, sessionID)` | Read tool aggregates |
| `ListSessions(ctx, filter)` | Timeline list; honors `SessionFilter.Limit` |
| `Search(ctx, query, filter, limit)` | FTS5 query → `SearchHit` (snippet + turn metadata + rank) |
| `ListSessionsWithBoilerplatePrompt(ctx, limit)` | Denoise sweep — iterates `internal/sessiontext.Prefixes` so SQL stays in lockstep with the Go classifier |
| `ListSessionsManifest(ctx, deviceID, after, limit)` | Reconcile cursor |
| `ListDevicesMap(ctx)` | `id → friendly_name` lookup |
| `RebindLocalSessions(ctx, deviceID)` | Migrate `local` seed device |
| `Analytics*` | Per-report queries |

The `SessionFilter` type carries the parsed `--since/--until/--project/...`
flags. Importers and the CLI share it; the panel uses the equivalent
proto-defined fields against the server.

`SessionFilter.ProjectMatch` is a substring filter that ORs across
`project_path`, `project_remote`, and `project_marker` — so
`--project movaincentivo` finds sessions whether they were captured
under a local subdirectory, a normalized git remote, or an explicit
`.prosa.yaml` marker. `SessionFilter.Limit > 0` caps the returned
rows (the bare `prosa --limit N` flag flows through here).

## Concurrency

WAL allows concurrent readers + a single writer. The CLI is the writer
during `prosa sync` (`store.Open`); read paths (`prosa`, `prosa show`,
`prosa search`, `prosa analytics`) call `store.OpenReadOnly`, which
adds `mode=ro` and a bounded pool — three parallel reader processes
against the same store finish without `database is locked`. The panel
doesn't read the local store at all on this machine.

No long transactions. Each `UpsertSession` + `InsertTurns` is a short
transaction wrapping the multi-statement work. The store does not use
SAVEPOINTs or batched outer transactions — empirically these regress under
WAL frame walking for our workload.

## Raw file layout

Per-session raw files are named **at preserve time** with the format
chosen by the importer (typically `<started-at>_<session-id>.jsonl`). The
absolute path lands in `sessions.raw_path`. No directory listing is ever
used to find files; everything goes through the column.

Files are written atomically: write to a temp file, fsync, rename.
Hash is computed before rename so a partial write can be detected and
discarded.

Removing the raw layer:

```sh
rm -rf -- "$HOME/.local/share/prosa/raw"
```

…will not be detected by the store on its own; the next reference
attempt errors. The MVP does not have a `prosa fsck` command; if the raw
layer drifts, the simplest recovery is to delete `store.db` and let
`prosa sync` rebuild from the server's manifest.

## Backup

There is no built-in backup. The two clean approaches:

- **Copy `store.db`** while no process is actively writing — WAL makes
  this safe with a few caveats (`PRAGMA wal_checkpoint(FULL)` first). For
  most setups, the easier path is to just push to the server.
- **Treat the server as the backup** — set up scheduled sync, lose the
  laptop, install on a new one, `prosa setup`, run `prosa sync`. The new
  device's store fills from the server's manifest on demand. (Note: the
  MVP does not yet pull historical sessions on demand; this is documented
  in [`../../INTENT.md`](../../INTENT.md#out-of-scope-intentionally).)

## When changing the store

- **New column on `sessions`**: add a migration in `migrations/local/`,
  update the Go struct in `pkg/session/types.go`, update every importer's
  mapping, update any affected query.
- **New table**: same pattern — migration plus a query file under
  `internal/store/`.
- **New query**: add a small, named function in the relevant file in
  `internal/store/<area>.go`. Don't build SQL outside the store package.
- **Schema-breaking change**: there is no online migration story here.
  Prefer additive changes; if you must break, write a clear up SQL and a
  recovery note.

Default validation lane:

```sh
just test ./internal/store/... -race
just ci
```
