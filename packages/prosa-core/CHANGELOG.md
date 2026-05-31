# @c3-oss/prosa-core

## 0.10.3

### Patch Changes

- 1298866: Fix Claude compile idempotency when changed or partially imported files recreate already-normalized spawn edges, and add supporting indexes for reimport performance.
- Fix `SQLITE_CONSTRAINT_UNIQUE` error on Claude compilation

## 0.10.2

### Patch Changes

- c321eba: Fix Hermes v1 reimports so parented sessions update in place instead of failing SQLite foreign key checks.

## 0.10.1

### Patch Changes

- Fix broken release of `v0.10.0`

## 0.10.0

### Minor Changes

- CLIv2

## 0.9.0

### Minor Changes

- Dashboard improvements

## 0.8.2

## 0.8.1

## 0.8.0

### Patch Changes

- 42efdfe: Persist local object transport hashes so repeated sync planning can avoid
  rehashing compressed CAS bytes after the first backfill.
