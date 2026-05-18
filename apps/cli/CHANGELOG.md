# @c3-oss/prosa

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
