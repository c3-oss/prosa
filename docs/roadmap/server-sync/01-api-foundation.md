# Server sync lane 1: API foundation

This lane creates the HTTP API host without changing local bundle semantics.
The goal is a small production-shaped app that can later receive auth, tenancy,
sync, and query routers.

## Goals

- Add `apps/api` as a workspace package named `@c3-oss/prosa-api`.
- Serve Fastify v5 with tRPC v11 mounted at `/trpc`.
- Expose a plain HTTP health endpoint at `/health`.
- Keep all server configuration explicit through environment variables.
- Export the tRPC `AppRouter` type so CLI and future web clients can consume a
  type-safe API without code generation.

## Package shape

`apps/api` should follow the existing monorepo conventions:

- ESM TypeScript, NodeNext, shared `tsconfig.base.json`.
- `src/server.ts` starts the process.
- `src/app.ts` builds and returns a Fastify instance for tests.
- `src/trpc/` owns context, router creation, and root router merging.
- `src/config.ts` parses environment variables with Zod.
- `test/` uses Fastify `inject()` for HTTP-level tests.

Root scripts and `.justfile` should gain package-aware aliases only when they
are useful across packages:

- `pnpm --filter @c3-oss/prosa-api dev`
- `pnpm --filter @c3-oss/prosa-api build`
- `pnpm --filter @c3-oss/prosa-api test`
- `just dev-api`

## Dependencies

Use current compatible versions at implementation time, starting with:

- `@trpc/server`
- `@trpc/client`
- `fastify`
- `zod`
- `pino`
- `better-auth`
- `@better-auth/drizzle-adapter`
- `drizzle-orm`
- `drizzle-kit`
- `postgres`

The API package should not depend on `better-sqlite3`, Tantivy, DuckDB, or the
local bundle filesystem directly. It can depend on shared sync types once
`packages/prosa-sync` exists.

## Runtime config

Required environment variables:

- `PROSA_API_URL`: public base URL used in auth links and CLI output.
- `PROSA_DATABASE_URL`: Postgres connection string.
- `PROSA_AUTH_SECRET`: Better Auth secret.
- `PROSA_OBJECT_STORE_DRIVER`: `s3`, `fs`, or `memory`.
- `PROSA_OBJECT_STORE_BUCKET`: required for `s3`.
- `PROSA_OBJECT_STORE_PREFIX`: optional key prefix, default `prosa/`.
- `PROSA_OBJECT_STORE_ROOT`: required for `fs`.

Optional variables:

- `PROSA_API_HOST`, default `127.0.0.1`.
- `PROSA_API_PORT`, default `3000`.
- `PROSA_LOG_LEVEL`, default `info`.
- S3-compatible endpoint and credentials for non-AWS providers.

## HTTP surface

- `GET /health` returns `{ "ok": true, "version": "<package version>" }`.
- `/trpc/*` handles all tRPC queries and mutations.
- Object upload/download routes are intentionally deferred to lane 4, because
  they depend on the remote object store contract.

Fastify should be created in a testable factory. Starting the server should be
the only side effect in `src/server.ts`.

## Acceptance criteria

- `pnpm --filter @c3-oss/prosa-api typecheck` passes.
- `pnpm --filter @c3-oss/prosa-api test` covers `/health` and a trivial tRPC
  procedure.
- `pnpm build` includes `apps/api` through Turbo without breaking CLI/core.
- The API can start locally with an `.env` file and connect to Postgres.

