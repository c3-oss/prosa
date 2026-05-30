# Self-hosting

This is the guide for the owner who runs their own `prosa-server` and
`prosa-panel`. If you only use the local CLI, you can skip this file.

prosa is designed for a **single owner**: one identity per server, an
owner-email whitelist, no tenancy. The server is small (a thin Postgres + S3
facade); the panel is small (server-rendered HTML + HTMX). Both ship inside
the same Docker image; the entrypoint defaults to `prosa-server`.

## What you need

- **Postgres 15+** with a database for prosa.
- **S3-compatible object storage** (AWS S3, R2, B2, MinIO — anything with the
  v2 API). One bucket; prosa shards inside it.
- **A public-facing HTTPS endpoint** for the panel (if you want the OAuth
  flow to work). The CLI can talk to plain HTTP for dev.
- **A GitHub OAuth app** (or Google — only the GitHub provider is wired in
  this MVP cut).
- **30 minutes** for first-time setup.

## Dev stack (single command)

For local dev with Postgres + MinIO + the server:

```sh
docker compose up -d                    # brings up Postgres + MinIO
PROSA_DB_URL=postgres://prosa:prosa@localhost:5432/prosa \
PROSA_S3_ENDPOINT=http://localhost:9000 \
PROSA_S3_BUCKET=prosa-raw \
PROSA_S3_ACCESS_KEY=prosa \
PROSA_S3_SECRET_KEY=prosaprosa \
PROSA_ADMIN_TOKEN=dev-admin-token \
PROSA_VERIFICATION_URI=http://localhost:8080/devices/approve \
./bin/prosa-server
```

The `docker compose` config in the repo provisions both services with
matching credentials. With those env vars exported, the server listens on
`:7070` by default.

## Production: server (`prosa-server`)

The server is one binary with no external dependencies beyond its config. It
serves Connect-Go RPC over HTTP/1.1 + h2c. Put TLS in front of it (Caddy,
nginx, Traefik, a CDN — whatever you trust).

### Required env vars

| Variable | Required | Notes |
| --- | --- | --- |
| `PROSA_DB_URL` | yes | `postgres://user:pass@host:port/db?sslmode=…` |
| `PROSA_S3_ENDPOINT` | yes | e.g. `https://s3.amazonaws.com`, `http://minio:9000` |
| `PROSA_S3_BUCKET` | yes (default `prosa-raw`) | One bucket holds everything. |
| `PROSA_S3_ACCESS_KEY` | yes | |
| `PROSA_S3_SECRET_KEY` | yes | |
| `PROSA_S3_REGION` | optional (default `us-east-1`) | Many S3-compatible services accept any value. |
| `PROSA_S3_USE_SSL` | optional (default `false`) | Set to `true` for HTTPS endpoints. |
| `PROSA_ADMIN_TOKEN` | yes | Used by the panel and by `prosa-server --approve`. Treat as a secret. |
| `PROSA_VERIFICATION_URI` | yes | The URL printed to the user during device-code login. Usually `https://your-panel.example.com/devices/approve`. |
| `PROSA_LISTEN_ADDR` | optional (default `:7070`) | Bind address. |

The server applies its Postgres migrations on startup. Migration files live
in `migrations/server/`.

### S3 layout

Raw transcript files are written as objects under one bucket, keyed by
`<device-id>/<agent>/<YYYY>/<MM>/<session-id>.jsonl`. The server returns the
S3 URI in `PushResponse.raw_uri` for audit.

There is no S3 lifecycle policy by default. Set retention rules at the
bucket level if you want them; prosa won't manage them.

### Postgres schema

The server schema is roughly: `devices`, `sessions`, `session_tools`,
`turns` (with a generated `content_tsv` column for FTS), `sync_state`,
`device_codes`, `device_tokens`. The `turns` table uses Postgres's native
FTS (simple tokenizer; no stemming) — different from the local store, which
uses SQLite FTS5 with the porter tokenizer.

Indexes are tuned for the queries that drive the panel and the
`--remote` CLI: composite indexes on `(device_id, started_at DESC)` and
GIN on `content_tsv`.

See [architecture/server.md](architecture/server.md) for the full schema
walk and migration history.

## Production: panel (`prosa-panel`)

The panel is also one binary. It speaks to `prosa-server` via Connect-Go and
serves HTML with HTMX swaps. There is no build step, no npm install — all
assets are embedded.

### Required env vars

| Variable | Required | Notes |
| --- | --- | --- |
| `PROSA_PANEL_SERVER_URL` | optional (default `http://localhost:7070`) | URL of `prosa-server`. |
| `PROSA_ADMIN_TOKEN` | yes | Same secret the server uses. The panel sends it as `Authorization: Admin <token>`. |
| `PROSA_PANEL_LISTEN_ADDR` | optional (default `:8080`) | Bind address. |
| `PROSA_PANEL_PUBLIC_URL` | yes for production | Used as the OAuth callback base. |
| `PROSA_PANEL_OAUTH_GH_CLIENT_ID` | yes (unless dev-login) | GitHub OAuth app client ID. |
| `PROSA_PANEL_OAUTH_GH_SECRET` | yes (unless dev-login) | GitHub OAuth app secret. |
| `PROSA_PANEL_COOKIE_KEY` | yes | 32+ bytes of hex. Used to HMAC-sign the session cookie. |
| `PROSA_PANEL_COOKIE_SECURE` | optional (default `false`) | Set to `true` behind HTTPS. |
| `PROSA_OWNER_EMAILS` | yes | CSV whitelist. Any verified GitHub email not in the list gets a 403. |
| `PROSA_PANEL_DEV_LOGIN` | optional (dev only) | If set to an email, exposes a passwordless `/dev-login` route. Prints a loud warning on boot. **Never enable in production.** |

### OAuth setup

Create a GitHub OAuth app with:

- Homepage URL: `https://your-panel.example.com`
- Authorization callback URL: `https://your-panel.example.com/oauth/github/callback`

Put the client ID and secret in the env vars above. Put your own email (or
emails — comma-separated) in `PROSA_OWNER_EMAILS`. Anyone else who logs in
gets a 403 page.

The panel session cookie is HMAC-signed with `PROSA_PANEL_COOKIE_KEY`,
marked `HttpOnly`, `Secure` (when `PROSA_PANEL_COOKIE_SECURE=true`),
`SameSite=Lax`, with a 30-day TTL.

### Dev-login bypass

For local development:

```sh
PROSA_PANEL_DEV_LOGIN=hi@caian.org ./bin/prosa-panel
```

A `/dev-login` POST endpoint appears that issues a session cookie for the
given email, with no OAuth roundtrip. The server logs a loud warning at
boot.

Do not enable this in production. The route prints a warning, but the
route is the wrong shape for a public deployment.

## Docker

The Dockerfile is multi-stage, multi-arch, and produces a distroless image
with all three binaries at `/usr/local/bin/`. The entrypoint is
`prosa-server`.

```sh
# pull
docker pull ghcr.io/c3-oss/prosa:latest

# server (default entrypoint)
docker run --rm \
  -e PROSA_DB_URL=... \
  -e PROSA_S3_ENDPOINT=... \
  -e PROSA_ADMIN_TOKEN=... \
  -e PROSA_VERIFICATION_URI=... \
  -p 7070:7070 \
  ghcr.io/c3-oss/prosa:latest

# panel — override entrypoint
docker run --rm \
  --entrypoint prosa-panel \
  -e PROSA_PANEL_SERVER_URL=http://server:7070 \
  -e PROSA_ADMIN_TOKEN=... \
  -e PROSA_PANEL_OAUTH_GH_CLIENT_ID=... \
  -e PROSA_PANEL_OAUTH_GH_SECRET=... \
  -e PROSA_PANEL_COOKIE_KEY=... \
  -e PROSA_OWNER_EMAILS=you@example.com \
  -e PROSA_PANEL_PUBLIC_URL=https://panel.example.com \
  -p 8080:8080 \
  ghcr.io/c3-oss/prosa:latest

# CLI — also from the same image
docker run --rm \
  --entrypoint prosa \
  ghcr.io/c3-oss/prosa:latest --help
```

Multi-arch tags built on every release: `linux/amd64`, `linux/arm64`.

The image build itself is documented in
[distribution/docker.md](distribution/docker.md).

## Approving a device manually

When a user runs `prosa login`, the server mints a device-code and prints a
URL the user must visit in their browser. The panel approves it.

If you don't want to run the panel, you can approve from a server shell:

```sh
prosa-server --approve <user-code>
```

The user code is what was printed to the user's terminal.

This is gated by `PROSA_ADMIN_TOKEN`. Treat that token carefully.

## Backup

prosa's "two layers" are easy to back up:

- Postgres: ordinary `pg_dump` works. The `turns.content_tsv` column is
  generated, so a dump-and-restore reproduces it.
- S3: ordinary bucket copy / replication. Object keys are stable; no
  re-keying needed.

The local store is per-device (no central source of truth for it). If you
lose the SQLite store on a device, the next `prosa sync` rebuilds it from
the server's manifest.

## Observability

- The server logs to stderr in `log/slog` text format.
- `/healthz` on both server and panel returns 200 when ready.
- There is no built-in metrics endpoint in this MVP cut. Front it with a
  proxy that exposes its own metrics if you need Prometheus.

## What's not here yet

- TLS termination inside the server. Use a reverse proxy.
- Built-in backup / restore CLI.
- Multi-tenant data partitioning. The schema has no `user_id`.
- Pre-MVP redaction at upload time. TLS in transit; trust at rest.

These are documented as out-of-scope in
[`../INTENT.md`](../INTENT.md#out-of-scope-intentionally).
