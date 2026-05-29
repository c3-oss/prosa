# @c3-oss/prosa

## 0.10.1

### Patch Changes

- 47357b6: Bundle internal v2 workspace packages into the CLI dist so `npm i -g @c3-oss/prosa` resolves.

  `@c3-oss/prosa@0.10.0` shipped with `dependencies` on five private workspace
  packages (`prosa-bundle-v2`, `prosa-derived-v2`, `prosa-importers-v2`,
  `prosa-types-v2`, `prosa-wire-v2`) that were never published, so npm install
  failed with `404 Not Found` on the first transitive lookup.

  This patch:

  - Adds `noExternal` for those five packages to `apps/cli/tsup.config.ts`, so
    their code is inlined into `dist/bin/prosa.js`.
  - Marks the transitive native bindings (`@duckdb/node-api`, `better-sqlite3`,
    `@oxdev03/node-tantivy-binding`, `zstd-napi`) and JS-only siblings
    (`@noble/hashes`, `zod`) as `external` so tsup does not try to bundle native
    `.node` files and platform-specific optional deps.
  - Moves the five v2 workspace packages from `dependencies` to
    `devDependencies` (they only need to be present at build time now), and
    promotes the native bindings to runtime `dependencies` so the published CLI
    declares everything it imports.

  `@c3-oss/prosa-core` continues to be published independently and stays
  external.

- Fix broken release of `v0.10.0`
- Updated dependencies
  - @c3-oss/prosa-core@0.10.1

## 0.10.0

### Minor Changes

- CLIv2

### Patch Changes

- Updated dependencies
  - @c3-oss/prosa-bundle-v2@0.2.0
  - @c3-oss/prosa-core@0.10.0
  - @c3-oss/prosa-derived-v2@0.2.0
  - @c3-oss/prosa-importers-v2@0.2.0
  - @c3-oss/prosa-types-v2@0.2.0
  - @c3-oss/prosa-wire-v2@0.2.0

## 0.9.0

### Minor Changes

- Dashboard improvements

### Patch Changes

- Updated dependencies
  - @c3-oss/prosa-core@0.9.0

## 0.8.2

### Patch Changes

- 104439b: Fix global npm installs by keeping the private sync workspace package out of published runtime dependencies.
  - @c3-oss/prosa-core@0.8.2

## 0.8.1

### Patch Changes

- e9e11da: Fix chunked sync when remote PostgreSQL projections contain NUL bytes and avoid retrying structured commit errors that are not transient.
- 10b40d1: Harden chunked sync uploads with retries and adaptive object upload concurrency.
  - @c3-oss/prosa-core@0.8.1

## 0.8.0

### Minor Changes

- 4206275: Add resumable chunked sync checkpoints plus CLI flags to ignore or reset saved
  sync checkpoint state.
- 3cebd25: Add sync CLI upload concurrency tuning, per-phase metrics, JSON-safe verbose output, and object PUT retries.

### Patch Changes

- 1d8fbf6: Improve local auth, compile, and sync flows for remote promotion.

  `prosa auth login` now works more reliably against the local API, explicit compile stores can be initialized automatically, relative compile source paths resolve from the invoking workspace, and sync can promote larger bundles in chunks while preserving local stores with `--keep-local`.

- 684ce06: Upload sync object packs with a binary wire format and keep JSON/base64 as a
  fallback for older servers.
- dcd4bfa: Fix chunked sync planning so child projection rows wait for their parent rows before promotion.
- 1f6bfe7: Send stable sync commit idempotency keys so interrupted commitUpload requests can
  be replayed safely.
- 8bda828: Stabilize sync promotion after the merged server/object-store changes, including
  packed-object validation and CLI chunk result handling.
- 42efdfe: Persist local object transport hashes so repeated sync planning can avoid
  rehashing compressed CAS bytes after the first backfill.
- Updated dependencies [42efdfe]
  - @c3-oss/prosa-core@0.8.0
