# Architecture: server

`prosa-server` is the cross-device backend. Clients push sessions to it,
read them back via `--remote`, and authenticate via the device-code flow.
Postgres stores metadata and the FTS over turns; an S3-compatible object
store keeps raw transcript bodies.

For the user-facing deployment guide see [`../self-hosting.md`](../self-hosting.md).
For the device-code flow as a concept see
[`../concepts.md#auth`](../concepts.md#auth).

The local CLI works fully offline — `prosa-server` is only needed for
cross-device sync or the panel.

## Shape

```
cmd/prosa-server/main.go                 thin entrypoint
└─ internal/server/
   ├─ server.go                          mux + Connect handler registration
   ├─ config.go                          env-driven configuration
   ├─ <service>.go                       per-service Connect handlers
   ├─ auth/                              device-code flow internals
   ├─ storage/                           S3 client wrapper
   └─ db/                                pgx pool, query helpers
```

Stdlib `net/http` + `http.ServeMux` for the listener. Connect-Go for RPC
(accepts both JSON and binary; the panel uses JSON, the CLI uses binary).
HTTP/2 over cleartext (h2c) in dev; put TLS in front of it in production.

## Configuration

All env-driven; no flags except `--approve`. Full list in
[`../self-hosting.md`](../self-hosting.md#required-env-vars). Required:

- `PROSA_DB_URL`
- `PROSA_S3_ENDPOINT`, `PROSA_S3_BUCKET`, `PROSA_S3_ACCESS_KEY`, `PROSA_S3_SECRET_KEY`
- `PROSA_ADMIN_TOKEN`
- `PROSA_VERIFICATION_URI`

Defaults: `PROSA_LISTEN_ADDR=:7070`, `PROSA_S3_BUCKET=prosa-raw`,
`PROSA_S3_REGION=us-east-1`, `PROSA_S3_USE_SSL=false`.

## Services

| Service | Methods | Purpose |
| --- | --- | --- |
| `AuthService` | `StartLogin`, `PollLogin`, `ApproveLogin`, `Whoami` | Device-code OAuth |
| `SessionsService` | `Push`, `List`, `Get`, `Search`, `Manifest`, `GetRaw` | Session CRUD + reconcile |
| `DevicesService` | `List`, `Rename`, `Revoke` | Device registry |
| `AnalyticsService` | `GetReport` | One of five fixed reports |
| `HealthService` | standard gRPC health | Liveness probe |

Proto in `proto/prosa/v1/`. Generated Go in `gen/go/prosa/v1/`, committed.

### Push

`SessionsService.Push` accepts a session + turns + tool aggregates + the
raw bytes. It is idempotent by `raw_hash`:

1. If the (device_id, session_id, raw_hash) tuple already exists in
   Postgres → no-op, return the existing S3 URI.
2. Otherwise: upload raw to S3, upsert into Postgres (replacing turns
   atomically), return the S3 URI.

The handler enforces a max raw size (configured in code) and a max content
length per turn (Postgres tsvector has a 1 MiB ceiling — see
[`../../TECH_DEBT.md`](../../TECH_DEBT.md)).

### List / Get / Search

Read paths. Each takes a structured filter (since/until/agent/device/
project), and either:

- queries Postgres directly for metadata + tools, or
- queries Postgres FTS (`tsvector` + GIN) for `Search`, joining back to
  session metadata for the response.

There's no Redis, no in-memory cache. Postgres is fast enough for
single-user volumes.

### Manifest

`Manifest` returns a paginated catalog of `(session_id, raw_hash,
last_synced_at)` for a device. The CLI uses it during `prosa sync` to
detect what's missing or stale on the server.

### GetRaw

Streams raw `.jsonl` bytes from S3 with byte-range support. The panel uses
it for paginated viewing of long transcripts (64 KB chunks).

## Auth

### Device-code flow

`prosa login` calls `StartLogin`. The server mints:

- a `device_code` (long, opaque, used in subsequent polls),
- a `user_code` (short, human-typable),
- an expiry (15 minutes).

Both go into `device_codes` with state `PENDING`. The server returns the
`user_code` and `PROSA_VERIFICATION_URI` to the client.

The user opens the URI in a browser. The panel's `/devices/approve` route
takes the `user_code` and calls `ApproveLogin` on behalf of the owner
(panel sends `Authorization: Admin <token>`). The server flips
`device_codes.state` to `APPROVED`, registers the device in `devices`,
mints a bearer token, stores its sha256 in `device_tokens`, and returns
the plaintext to the panel.

The CLI's `PollLogin` loop sees the approved state and receives the
bearer token. It writes it to `~/.config/prosa/auth.json` and stops
polling.

Tokens are revocable: `DevicesService.Revoke` sets
`device_tokens.revoked_at`. The Connect interceptor rejects revoked
tokens on every request.

### Manual approval

For owner setups without a running panel:

```sh
PROSA_ADMIN_TOKEN=... prosa-server --approve <user_code>
```

Equivalent to the panel's call to `ApproveLogin`, useful for first-time
self-hosters before the panel is up.

### Interceptor

A Connect interceptor runs on every request:

- Extracts the `Authorization` header.
- If it starts with `Admin `, verifies against `PROSA_ADMIN_TOKEN` and
  attaches a `(role=owner)` context.
- If it starts with `Bearer `, looks up `sha256(token)` in
  `device_tokens`, verifies not revoked, attaches a `(device_id, ...)`
  context.
- Otherwise rejects with `Unauthenticated`.

Handlers read the context to decide who the caller is.

## Schema

Migrations in `migrations/server/`, applied at startup via `embed.FS`.

| Migration | What it adds |
| --- | --- |
| `0001_init` | `devices`, `sessions`, `session_tools`, `turns` (with `content_tsv` GENERATED column + GIN index), `sync_state`, `device_codes`, `device_tokens` |
| `0002_manifest_index` | composite `(device_id, started_at DESC)` index on `sessions` |
| `0003_turns_tsvector_cap` | guards against the 1 MiB tsvector ceiling |
| `0004_session_notify` | `pg_notify` trigger feeding the SSE stream |

The shape mirrors the local SQLite schema where it matters; the
differences are:

- `started_at` / `last_activity_at` are `TIMESTAMPTZ` (not text).
- `turns.id` is `BIGSERIAL`.
- `turns.content_tsv` is a `tsvector GENERATED ALWAYS AS … STORED`, indexed
  with GIN. **Tokenizer is `simple`** (no stemming) — different from the
  local `porter+unicode61`.
- `device_codes` and `device_tokens` exist server-side only.

For the session-level field mapping (importer → canonical), see
[canonical-session.md](canonical-session.md).

## S3 layout

Objects are written as
`<device-id>/<agent>/<YYYY>/<MM>/<session-id>.jsonl`. One bucket. No
per-tenant prefix; there is no tenancy.

The server returns the S3 URI in `PushResponse.raw_uri` for audit, but
that URI is only meaningful inside the deployment — the panel always
fetches raw bytes through `GetRaw`, not through S3 directly.

## SSE

`/sse/events` is a server-sent events stream. Listeners (the panel
proxies the stream to browsers) receive `session.upserted` events when a
new session lands. The events are driven by the Postgres `NOTIFY` trigger
from migration `0004`. No polling; no per-listener Postgres connection
beyond a single LISTEN session per server process.

## Concurrency

`pgx` pool sized via `PROSA_DB_URL` query params (`pool_max_conns`,
etc.). Default sizing comes from the driver. No long transactions; the
server uses short upsert / read transactions.

## What's not here yet

- Built-in TLS termination. Put a reverse proxy in front.
- Built-in metrics. Front it with a proxy that handles Prometheus.
- Backup / restore CLI.
- Multi-tenant data partitioning (intentional; see INTENT).
- Server-side redaction (intentional; see INTENT).

## When changing the server

- **New env var** → document in [`../self-hosting.md`](../self-hosting.md)
  and `internal/server/config.go`.
- **New proto method** → edit `proto/prosa/v1/<service>.proto`, run
  `just gen`, implement the handler in `internal/server/<service>.go`.
- **New schema column** → migration in `migrations/server/`, struct in
  `internal/server/db/`, handler updates.
- **New endpoint outside Connect** (e.g. another SSE stream) → register on
  the mux in `internal/server/server.go`, document the route here.

Default validation lane:

```sh
just test ./internal/server/... -race
just gen-check
just ci
```

For a release-grade check, add `just snapshot` and `docker build -t
prosa:local .` — they're cheap locally and catch most cross-arch
regressions.
