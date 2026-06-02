# Concepts

The shared vocabulary of prosa. Read this once and the rest of `docs/` will
make more sense. For the **why** behind these choices, see
[`../INTENT.md`](../INTENT.md).

## Session

A *session* is one unbroken interaction with an AI coding agent — a single
JSONL file on disk, from the moment the agent started until the moment it
stopped or moved on.

Every session has:

- a **stable ID** assigned by the source agent (Claude Code, Codex, Cursor,
  Gemini, Antigravity, Hermes) — prosa never invents one;
- an **agent** name (`claude-code`, `codex`, `cursor`, `gemini`, `antigravity`, `hermes`);
- a **device** it ran on (see [Device identity](#device-identity));
- a **project context** (see [Project identity](#project-identity));
- a **timestamp** for start and last activity;
- a **first prompt** (the user's first message, truncated for display);
- a **model** the agent used (e.g. `claude-sonnet-4-6`);
- the **raw JSONL** preserved on disk, hash-addressed by sha256;
- a stream of **turns** (user/assistant messages) extracted for FTS;
- an aggregation of **tool usage** (`Read` 14, `Bash` 7, …).

The canonical mapping every importer must satisfy is documented in
[architecture/canonical-session.md](architecture/canonical-session.md). The
domain types live in `pkg/session/types.go`.

## Session lifecycle

```
┌──────────┐    file appears or changes
│  detect  │ ───────────────────────────┐
└──────────┘                            ▼
                              ┌───────────────────┐
                              │  hash sha256      │
                              └────────┬──────────┘
                                       │
                  hash unchanged       │     hash differs
                  ┌────────────────────┼────────────────────┐
                  ▼                                         ▼
            ┌──────────┐                          ┌──────────────────┐
            │  no-op   │                          │  parse + extract │
            └──────────┘                          └────────┬─────────┘
                                                            │
                                                            ▼
                                                  ┌────────────────────┐
                                                  │ upsert metadata    │
                                                  │ rewrite turns      │
                                                  │ rewrite tool counts│
                                                  │ preserve raw       │
                                                  └────────┬───────────┘
                                                           │
                                                           ▼
                                                  ┌────────────────────┐
                                                  │ push to server     │
                                                  │ update sync_state  │
                                                  └────────────────────┘
```

A session is **active** when its `last_activity_at` is within 10 minutes of
now. The CLI marks active sessions with `*`; the panel shows a live dot.
Active sessions are synced normally — the hash flips as the raw file grows,
which triggers a new push. There is no debounce.

A session is **closed** when `last_activity_at` is older than 10 minutes.
Closed sessions are only synced if their raw file is modified after the
fact (rare — agents usually rotate to a new session).

A session is **orphaned** if the source agent deletes or rotates the
original `.jsonl`. prosa keeps the raw copy it already preserved. There is
no auto-delete, no `prosa prune` in the MVP. Disk is cheap.

## Project identity

prosa picks a project for each session in this order:

1. **`git remote get-url origin`** in the session's working directory.
   The URL becomes the project identity. Stable across devices (the same
   repo on two laptops resolves to the same project).
2. **`.prosa.yaml` marker file** in the cwd or an ancestor, with a
   `project: <name>` field.
3. **The cwd path itself** as a fallback. Marked as `unscoped` — visible
   in timelines but kept separate from real projects.

Sessions in the same project (by remote URL or marker) on different devices
are the **same project**. This is what makes `--remote` analytics
meaningful.

## Device identity

A *device* is a single machine prosa has been set up on. Each device has a
fingerprint and a `friendly_name`.

Fingerprint = `hash(hostname + machine-id)`. Sources of the machine-id:

- **Linux**: `/etc/machine-id`.
- **macOS**: `IOPlatformUUID`.
- **Windows**: `MachineGuid` from the registry. (Not in MVP target
  platforms.)

The `friendly_name` defaults to the hostname. You can rename via
`prosa devices rename <id|self> <name>` (cross-device only, talks to the
server).

The CLI sends its device fingerprint as part of every authenticated request.
The server uses this to attribute pushed sessions to a device.

## Auth

Two flavors, both single-user.

**CLI auth (PKCE + localhost callback)**: `prosa login` (or the `prosa setup`
wizard) calls `AuthService.BeginLogin` with a PKCE challenge and a
`http://127.0.0.1:<port>/callback` redirect. The CLI opens the panel
authorize URL in the browser; you click **Authorize this device**. The panel
redirects the auth code to the CLI's local listener; the CLI calls
`ExchangeCode` and saves the bearer to `~/.config/prosa/auth.json`.

On headless machines, forward the callback port with `ssh -L` or copy
`auth.json` from a machine that completed login.

Tokens are revocable via `prosa devices revoke <id|self>`. The server
stores only the hash of each token, never the plaintext.

**Panel auth (OAuth)**: GitHub OAuth (Google is wired but not in MVP cut).
The verified email is matched against `PROSA_OWNER_EMAILS`. Any non-listed
email gets a 403. The session is an HMAC-signed cookie (`HttpOnly`,
`Secure`, `SameSite=Lax`, 30-day TTL).

For dev: `PROSA_PANEL_DEV_LOGIN=<email>` exposes a passwordless
`/dev-login` route. The server logs a loud warning at boot. Don't enable in
production.

## Local-first

The CLI reads the local store by default. No network calls. No "the server
is down" failure mode for everyday queries.

- `prosa` (the timeline), `prosa search`, `prosa show`, `prosa analytics` —
  all local by default.
- `--remote` is opt-in. When you pass it, the same command runs against the
  server (Postgres FTS, server-side analytics).
- `prosa sync` is the only command that always touches the server.

Practical consequence: you can work offline indefinitely. When you come
back online, the next `prosa sync` (manual or scheduled) reconciles
everything via the manifest.

## Push-only sync

Sync is one-way: client → server. The server stores; it does not push back.

- Per session, the client computes `sha256(raw)`.
- If `hash == sync_state.last_hash`, no-op.
- Otherwise: `Push(session, turns, tools, raw)` over Connect. The server
  stores the raw in S3, upserts Postgres, and returns the S3 URI.
- The client updates `sync_state.last_hash`.

Re-syncs are cheap: every session re-hashes in milliseconds; unchanged
sessions become no-ops.

There is no diff sync, no byte-range upload, no per-turn streaming. Hashing
the whole file is fast enough — see
[`../INTENT.md`](../INTENT.md#out-of-scope-intentionally).

## Layered store

The store has two layers, each with one job:

- **Metadata + FTS** in a database (SQLite locally, Postgres remotely).
  Indexed; queryable by SQL. Holds session metadata, the extracted turns
  for FTS, and tool aggregates.
- **Raw transcript files** on disk (locally) or in S3 (remotely).
  Hash-addressed. Never mutated.

The raw layer is the source of truth for content. The metadata layer is a
derivable index — if it's lost, the next sync rebuilds it from the manifest.

There is no DuckDB, no Parquet, no content-addressable store. SQLite +
Postgres is enough. See
[`../INTENT.md`](../INTENT.md#out-of-scope-intentionally) for why.

## MVP scope

In a sentence: the smallest thing that lets one person answer *what did I
work on in the last N days?* across the agents and machines they use,
including the analytics around the work.

Specifically in scope:

- Three Go binaries: `prosa`, `prosa-server`, `prosa-panel`.
- Importers for Claude Code, Codex, Cursor, Gemini.
- Single-user auth (PKCE + localhost callback for CLI, OAuth + whitelist for panel).
- Push-only sync, idempotent by sha256.
- Chronological timeline with project/agent/device/time filters.
- FTS over turns (local and remote).
- Fixed analytics reports, including session/tool/model/project/error counts,
  daily activity heatmap, and token usage/cost estimates where agents expose
  reliable counters.
- Scheduled background sync.

Specifically out of scope (today):

- Multi-tenant. The schema has no `user_id`. Organizations and users are a
  known post-MVP direction.
- MCP server. High-value, possibly post-MVP.
- Residential TUI. The panel handles long-form browsing.
- Export. The raw is on disk; roll your own.
- Redaction at upload. TLS in transit; trust at rest.
- Pull-down of remote sessions to the local store. Push-only stays
  push-only.
- Automatic retention / pruning. Manual if you ever need it.
- Cold-tier object storage. One bucket.
- Incremental upload by byte range or turn. Whole-file hash is fast enough.
- DuckDB / Parquet / columnar sidecars.

When in doubt about scope, see
[`../INTENT.md`](../INTENT.md#out-of-scope-intentionally) and ask whether
the change serves the central question.
