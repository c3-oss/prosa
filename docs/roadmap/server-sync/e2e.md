# Docker-backed E2E for the prosa server-sync feature

The unit + integration tests under `apps/api/test/*.test.ts` and
`apps/cli/test/cli/sync-promotion.test.ts` cover the protocol against
PGlite (in-process Postgres) and an in-memory object store. That suite
runs without external services and is part of `just test-all`.

The Docker-backed suite under `apps/api/test/e2e/` exercises the same
protocol against real Postgres + S3 (MinIO) so we catch issues that
PGlite/in-memory adapters mask.

## Prerequisites

- Docker engine reachable from the working directory.
- The pnpm workspace installed (`pnpm install`).

## Bring services up

```sh
just e2e-up
```

This boots:

- `postgres:16-alpine` on host port `${PROSA_TEST_POSTGRES_PORT:-54329}`
- `minio/minio:latest` on host ports
  `${PROSA_TEST_MINIO_PORT:-54392}` (S3 API) and `:54393` (console)

Both have healthchecks; the `--wait` flag holds until they report
ready.

## Run the E2E suite

```sh
just e2e
```

The recipe exports the following environment variables before invoking
`pnpm --filter @c3-oss/prosa-api test test/e2e`:

| Variable | Default |
| --- | --- |
| `PROSA_TEST_POSTGRES_URL` | `postgres://prosa:prosa@127.0.0.1:54329/prosa_test` |
| `PROSA_TEST_S3_ENDPOINT` | `http://127.0.0.1:54392` |
| `PROSA_TEST_S3_BUCKET` | `prosa-test` |
| `PROSA_TEST_S3_ACCESS_KEY` | `prosa` |
| `PROSA_TEST_S3_SECRET_KEY` | `prosa-minio` |
| `PROSA_TEST_S3_REGION` | `us-east-1` |

E2E tests detect the absence of these variables and skip themselves;
the suite is `describe.skipIf(!shouldRun)`-gated so it does not break
`just test-all` when Docker is not available.

## Tear services down

```sh
just e2e-down
```

This stops the containers and removes their named volumes.

## What the suite proves

`apps/api/test/e2e/postgres-s3.e2e.test.ts` runs the full happy path
end-to-end:

1. Apply the Drizzle bootstrap schema to a freshly-dropped Postgres
   `public` schema.
2. Ensure the MinIO bucket exists.
3. Boot the Fastify API against the real Postgres + S3 adapters.
4. Sign up a tenant, handshake a device, plan an upload with one
   declared object, `PUT` the bytes through `/objects/:id`, commit
   projection rows, and verify the promotion.
5. Confirm the bytes round-trip through MinIO by issuing a
   `HeadObject` against the CAS fanout key.

## Manual fallback

If Docker is not available, the same protocol path is validated by
PGlite + MemoryObjectStore in `apps/api/test/sync.test.ts` and
`apps/api/test/multidevice.test.ts`. Promotion-cleanup behaviour is
validated end-to-end in `apps/cli/test/cli/sync-promotion.test.ts`.
