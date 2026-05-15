# Server sync lane 5: CLI auth and remote authority

This lane makes the existing CLI able to authenticate with a remote Prosa server,
promote a local bundle to the server, and then route reads and heavy processing
to the server.

## Goals

- Add `prosa auth ...` commands.
- Add `prosa sync` as one-way promotion from local `.prosa` to the server.
- Remove local bundle data after verified promotion.
- Store remote credentials and authority metadata outside the bundle.
- Make every read command automatically use the server once the store is
  promoted.

## Local config

Store CLI auth and remote authority state under the user's config directory, not
inside `.prosa`. Suggested path:

```text
~/.config/prosa/config.json
```

The config stores:

- Server base URL.
- Active tenant id.
- Device id.
- User id and email for display.
- Bearer token or refreshable token material supported by Better Auth.
- Promotion receipts keyed by former local store path.
- Whether reads should be served remotely for the active tenant.

Never store auth tokens in `manifest.json`, `prosa.sqlite`, exported Markdown,
Parquet, logs, or test fixtures.

## Auth commands

`prosa auth signup`

- Prompts for server URL, user name, email, password, and tenant name.
- Calls the signup-with-tenant API.
- Saves returned auth state and active tenant.

`prosa auth login`

- Default flow uses device authorization.
- Prints verification URL and user code.
- Polls until approved, denied, or expired.
- Saves bearer auth state and device id.

`prosa auth logout`

- Revokes local token when the server is reachable.
- Clears local auth state for that server.
- Does not delete remote tenant data.

`prosa auth status`

- Shows server URL, user, active tenant, device id, token validity, and whether
  the current store path has been promoted.
- Does not print secrets.

`prosa auth tenants`

- Lists tenants available to the current user.

`prosa auth use <tenant>`

- Sets active tenant by id or slug.

## Sync command

`prosa sync`

- Requires login and active tenant.
- Opens the current local bundle.
- Uploads missing CAS objects and projection rows.
- Verifies that the server can answer equivalent reads.
- Records a promotion receipt.
- Deletes local `.prosa` data after successful verification.
- Makes future CLI reads use the server by default.

Useful options:

- `--server <url>`
- `--tenant <id-or-slug>`
- `--store <path>`
- `--dry-run`
- `--keep-local`
- `--json`
- `--verbose`

`--keep-local` is for debugging and migration validation only. Even when it is
used, the config marks the store as remote-authoritative after successful
promotion, so read commands still use the server.

`prosa sync status`

- Shows local bundle path, remote server, active tenant, device id, promotion
  state, last upload, cleanup state, and pending local changes when a bundle
  still exists.

There is no `prosa sync pull`. Another device logs in, chooses the tenant, and
queries the server directly.

## Read command routing

Before login and sync:

- `compile`, `compile-all`, `sessions`, `search`, `query`, `analytics`,
  `export`, `mcp`, and `tui` operate against local `.prosa`.

After login and successful sync:

- `sessions`, `search`, `query`, `analytics`, `export`, `mcp`, and `tui` call
  server APIs for the active tenant.
- Reports, views, Parquet exports, Markdown exports, and future derived outputs
  are generated on the server and streamed or downloaded as results.
- Local bundle files are not consulted, even if cleanup left leftovers.

For new local agent history after promotion, the CLI should support a later
incremental upload path that compiles from source history into an upload batch
without rebuilding long-lived local `.prosa` state.

## UX rules

- A missing login produces a concise error with `prosa auth login`.
- A missing active tenant produces a concise error with `prosa auth tenants`.
- A promoted store with leftover local files warns and retries cleanup.
- `--dry-run` never uploads bytes, writes remote rows, or deletes local data.
- `--json` must be stable enough for automation.
- Sync tests never point at a real `~/.prosa` store.

## Implementation notes

- Place CLI command files under `apps/cli/src/cli/commands/`.
- Put reusable network/client logic in `packages/prosa-sync`.
- Keep command output formatting in the CLI package.
- Reuse existing bundle helpers for the pre-promotion local read.
- Add a routing helper that decides local vs. server authority once per command.

## Acceptance criteria

- Device login works from a terminal without a browser embedded in the CLI.
- `auth status` reflects server session and promotion state.
- `sync --dry-run` reports expected upload and cleanup actions without mutation.
- `sync` sends a local bundle to the server, verifies it, and removes local
  bundle data.
- After sync, `search`, `sessions`, analytics, and exports are served by the
  server.
- Device B can log in and query data uploaded by device A without creating a
  local bundle.

