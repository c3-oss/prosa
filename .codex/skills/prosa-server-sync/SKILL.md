---
name: prosa-server-sync
description: Multi-tenant API server, remote schema/object store, and one-way promotion sync for prosa. Use when modifying apps/api, packages/prosa-{db,storage,sync}, the auth/sync CLI commands, the promotion protocol, manifest contracts, or the E2E Docker harness.
---

# Prosa Server Sync

Use this skill for the remote half of prosa: the multi-tenant HTTP/tRPC server, the Postgres + object-store backing it, the one-way client→server promotion protocol, and the auth and sync CLI surfaces. The canonical reference is `docs/architecture/server-sync.md`; pair with `$prosa-store-schema-cas` only when reasoning about the local bundle the client promotes from.

For large server-sync implementation or hardening runs driven by Claude Ralph
Loop, pair this skill with `$ralph-loop-governor`. `$prosa-server-sync` owns the
domain rules; `$ralph-loop-governor` owns the prompt, correction queue, evidence
manifests, reviewer lanes, and final gates.

When invoked inside a Ralph Loop, provide domain invariants, owned paths,
focused tests, and E2E requirements to the governor. Do not create or manage
correction queues, status files, or Ralph completion gates directly.

## Layout

- API server: `apps/api/src/{server,app,trpc,http,auth,db,storage,config,version,index}.ts` plus the binary at `apps/api/src/bin/`.
- tRPC routers: `apps/api/src/trpc/{init,context,router}.ts` and per-domain routers under `apps/api/src/trpc/routers/{auth,reads,sync,tenant}.ts` plus the chunked-sync subtree in `routers/sync/`.
- Object byte HTTP routes (upload/download outside tRPC): `apps/api/src/http/objects.ts`.
- Remote schema: `packages/prosa-db/src/schema/{auth,objects,projection,sync}.ts`, migrations driven by `packages/prosa-db/src/migrate.ts`.
- Object store adapters: `packages/prosa-storage/src/adapters/{memory,fs,s3}.ts`, selected by `factory.ts` and verified by `verify.ts`.
- Shared sync schemas and protocol types: `packages/prosa-sync/src/{schemas,index}.ts`.
- CLI glue: `apps/cli/src/cli/auth/{client,config,routing}.ts`, `apps/cli/src/cli/sync/{bundle,limits,promotion}.ts`, and the `auth` and `sync` subcommands in `apps/cli/src/cli/commands/{auth,sync}.ts`.

## Server Stack

- Fastify hosts a tRPC adapter plus raw HTTP routes for object byte transfer. tRPC handles the structured RPCs; bulk object PUT/GET stays on plain HTTP to keep streaming simple.
- Better Auth provides email/password and the organization plugin. Tenancy is multi-org: every authenticated request resolves an active `organizationId` via the tRPC context, and every read/write is scoped to it.
- Device tokens authenticate non-interactive CLI clients (`prosa auth login`, `prosa sync …`). Tokens carry the tenant and device identity and are validated in the tRPC context.
- Postgres holds auth tables, the remote projection (the same canonical projection the local bundle exposes), and the sync ledger. Drizzle owns the schema; migrations live next to the schema in `packages/prosa-db/`.
- The object store is driver-pluggable. `memory` powers tests, `fs` powers single-node deployments, `s3` powers production (and MinIO in the Docker harness). All three implement the same `verify`-able contract.

## Promotion Protocol

The sync direction is one-way: the local bundle is the source of truth, the server is an authoritative replica.

- The client computes a manifest describing the bundle slice it wants to promote (canonical rows + the object hashes they reference), signs it with the device token, and submits it.
- The server validates the manifest against the tenant scope, persists missing objects through the storage adapter, then applies the projection rows transactionally.
- Object byte upload is idempotent: re-PUT of an existing BLAKE3 hash is a no-op. Manifest application is idempotent on `(organization_id, ...natural keys)` — re-submitting the same manifest must not duplicate rows or grow object counts.
- Orphan bytes (objects uploaded but never referenced by an applied manifest) are cleaned up explicitly on catalog insert failure so a partial promotion never leaves trailing bytes.
- Remote reads are remote-authoritative: the server returns its own projection rather than asking the client to re-derive anything. Read endpoints live under `trpc/routers/reads.ts`.

## CLI Surface

- `prosa auth login|logout|whoami|use-org` configures device tokens and the active organization through `apps/cli/src/cli/auth/`.
- `prosa sync push` (and any chunked-sync subcommands) promotes the local bundle, driven by helpers in `apps/cli/src/cli/sync/{bundle,limits,promotion}.ts`.
- Both surfaces resolve the API URL, tenant, and token through the shared auth client; never hardcode endpoints.

## Configuration

Env vars (see `apps/api/src/config.ts` and `docker-compose.yml`):

- `PROSA_RUNTIME_MODE`, `PROSA_API_HOST`, `PROSA_API_PORT`, `PROSA_API_URL`, `PROSA_LOG_LEVEL`.
- `PROSA_DATABASE_URL` (Postgres DSN).
- `PROSA_AUTH_SECRET` (Better Auth signing key — never commit a real value).
- `PROSA_OBJECT_STORE_DRIVER` (`memory` | `fs` | `s3`) plus driver-specific knobs: `PROSA_OBJECT_STORE_BUCKET`, `PROSA_OBJECT_STORE_PREFIX`, `PROSA_OBJECT_STORE_ENDPOINT`, `PROSA_OBJECT_STORE_REGION`, `PROSA_OBJECT_STORE_ACCESS_KEY_ID`, `PROSA_OBJECT_STORE_SECRET_ACCESS_KEY`.

## E2E Harness

The Docker compose stack at the repo root brings up Postgres, MinIO, the bucket bootstrapper, and the API:

```bash
just e2e-up      # boot postgres + minio + api
just e2e         # run the full e2e suite against the stack
just e2e-cli     # run the CLI-side e2e flow (auth + sync) against the stack
just e2e-down    # tear the stack down
```

Use the harness for any change that touches the promotion protocol, manifest contract, or object byte HTTP routes; unit tests alone cannot exercise the storage + Postgres + Fastify path.

## Validation

- Add focused tests next to the change: `apps/api/test/` for routers and HTTP, `packages/prosa-db/test/` for schema and migrations, `packages/prosa-storage/test/` for adapters (use the `memory` adapter as the contract baseline), `packages/prosa-sync/test/` for shared schemas.
- For CLI sync/auth changes, exercise `apps/cli/test/cli/{auth,sync}.test.ts` plus the E2E harness.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm lint` before finishing; gate protocol-shape changes on the E2E suite too.

## Risk Checks

- Never widen a query past `organizationId` — multi-tenancy leaks here.
- Never make the server derive canonical data the client did not promote; reads stay remote-authoritative on what was promoted.
- Keep manifest application transactional and idempotent; clean up uploaded bytes on catalog failure.
- Do not commit real `PROSA_AUTH_SECRET` or storage credentials; compose defaults are development-only.

## Ralph Loop Hand-Off

When generating a Ralph Loop prompt for server-sync work, include these domain
invariants explicitly:

- The sync direction remains one-way: local bundle to remote server.
- `verifyPromotion` is the cleanup gate and must prove declared objects,
  source files, raw records, sessions, and search docs.
- Object identity is canonical BLAKE3 over original bytes; transport hash is
  separate.
- Tenant membership, device ownership, and object routes share the same
  authorization semantics.
- Docker-backed E2E must cover API, Postgres, object storage, CLI sync, and
  a second device reading remotely.
