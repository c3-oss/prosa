# prosa-server

`prosa-server` is the cross-device backend. Clients push sessions to it,
read them back via `--remote`, and authenticate via device codes (per
INTENT.md §6). Postgres stores metadata + FTS over turns; an
S3-compatible object store keeps the raw transcript bodies.

The local CLI (`prosa`) works fully offline — `prosa-server` is only
needed when you want cross-device sync or want to browse history from
the (eventual) panel.

## Running the dev stack

```bash
# 1. Postgres + MinIO
docker compose up -d

# 2. Server (nativo, lê env vars)
PROSA_DB_URL='postgres://prosa:prosa@localhost:5432/prosa?sslmode=disable' \
PROSA_S3_ENDPOINT='localhost:9000' \
PROSA_S3_BUCKET='prosa-raw' \
PROSA_S3_ACCESS_KEY='prosa' \
PROSA_S3_SECRET_KEY='prosaprosa' \
PROSA_ADMIN_TOKEN='devadmin' \
PROSA_VERIFICATION_URI='http://localhost:7070/login' \
./bin/prosa-server
```

## Env vars

| Var | Default | Required | Purpose |
|---|---|---|---|
| `PROSA_LISTEN_ADDR` | `:7070` | no | HTTP listen address |
| `PROSA_DB_URL` | — | **yes** | Postgres connection string |
| `PROSA_S3_ENDPOINT` | — | **yes** | S3-compatible endpoint (`localhost:9000`, `s3.amazonaws.com`, `…r2.cloudflarestorage.com`) |
| `PROSA_S3_BUCKET` | `prosa-raw` | no | Bucket name |
| `PROSA_S3_ACCESS_KEY` | — | **yes** | Access key |
| `PROSA_S3_SECRET_KEY` | — | **yes** | Secret key |
| `PROSA_S3_USE_SSL` | `false` | no | Set `true` in production |
| `PROSA_S3_REGION` | `us-east-1` | no | MinIO ignores; R2/B2 accept any string |
| `PROSA_ADMIN_TOKEN` | — | **yes** | Bearer for `prosa-server --approve` |
| `PROSA_VERIFICATION_URI` | — | **yes** | URI surfaced in `StartLoginResponse` |

## Approving logins (until Group D)

The `prosa login` device-code flow needs an approver. Until the panel
ships:

```bash
# 1. From a fresh device:
prosa login --server http://localhost:7070

# Output prints user_code + verification_uri. CLI starts polling.

# 2. From a terminal that has PROSA_ADMIN_TOKEN:
PROSA_ADMIN_TOKEN=devadmin ./bin/prosa-server --approve <user_code>

# 3. The original `prosa login` window flips to "logged in" and writes
#    ~/.config/prosa/auth.json.
```

## Schema

`migrations/server/0001_init.up.sql` mirrors the local SQLite schema
plus auth tables:

- `devices` — every machine that ever pushed.
- `sessions` / `session_tools` / `turns` (with `content_tsv` TSVECTOR +
  GIN index) — mirror of local store.
- `sync_state` — `(session_id, last_hash, last_synced_at)` for idempotent
  pushes.
- `device_codes` — short-lived PENDING/APPROVED state for the OAuth flow.
- `device_tokens` — `sha256(bearer)` only; the raw token never lives in
  the DB.

The Postgres `simple` tokenizer is used for FTS; ranking diverges a bit
from SQLite's `porter+unicode61`, but both hit the same documents.
