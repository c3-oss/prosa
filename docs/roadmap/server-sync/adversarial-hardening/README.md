# Server Sync Adversarial Hardening

Status: draft

This directory contains the adversarial correction lanes for the current
server-sync implementation. These lanes are intentionally written as security
and reliability work, not feature work. The goal is to close ways the server
can certify, expose, or delete data before it has enough proof that the remote
state is complete, tenant-scoped, and reproducible.

The review assumes the current branch state after the Ralph loop plus Codex's
post-loop corrections. Those corrections materially improved the CAS promotion
path, but they did not make the system fully shippable for hostile or failure
heavy environments.

## Summary Verdict

The implementation is a strong prototype foundation, but it is not yet hardened
enough for production sync. The highest-risk areas are:

- `commitUpload` is not atomic, and partially committed rows can become
  readable.
- The server still does not own an immutable batch manifest; it trusts client
  declarations at verify time.
- Object upload is buffered and decompressed in-process, creating memory and
  decompression-bomb risk.
- Remote object metadata does not persist transport hash, so later verification
  cannot fully re-prove zstd object bytes.
- Large local bundles can exceed `maxRowsPerCommit` after removing the old
  `LIMIT 5000`, because the protocol has no chunking.
- Remote-authoritative CLI behavior remains incomplete for several read
  surfaces.
- Migration/schema definitions are split between bootstrap SQL and Drizzle
  schema, with constraints not verified on startup.
- Auth/device flows need abuse controls, token lifecycle hardening, and audit
  events.

## Lane Order

The lanes are ordered by risk and dependency. Do not reorder unless a blocker
requires it.

1. [Lane 01: Transactional Promotion State Machine](./lane-01-transactional-promotion.md)
2. [Lane 02: Server-Owned Batch Manifest And Receipts](./lane-02-server-owned-manifest.md)
3. [Lane 03: CAS/Object Store Hardening](./lane-03-cas-object-store-hardening.md)
4. [Lane 04: Schema, Constraints, And Migrations](./lane-04-schema-constraints-migrations.md)
5. [Lane 05: Chunked Sync And Large Bundle Safety](./lane-05-chunked-sync-large-bundles.md)
6. [Lane 06: Remote-Authoritative Read Surface](./lane-06-remote-authoritative-reads.md)
7. [Lane 07: Auth, Device, Tenant, And Abuse Controls](./lane-07-auth-device-tenant-abuse.md)
8. [Lane 08: Adversarial Test Gate And Operations](./lane-08-adversarial-test-gate-ops.md)

## Global Done Criteria

All lanes are done only when:

- `pnpm i` passes.
- `pnpm build` passes and builds every workspace.
- `just typecheck` passes.
- `just test-all` passes.
- `just lint-all` passes.
- `just e2e-up`, `just e2e`, `just e2e-cli`, `just e2e-down` pass.
- Adversarial tests from Lane 08 pass.
- `pnpm audit --audit-level moderate` is either clean or every advisory has a
  documented risk classification and follow-up.
- No destructive local cleanup can happen unless the server can prove the
  promoted state from server-owned records, not client-provided declarations.

## Severity Model

- Critical: can cause cross-tenant data exposure, forged promotion, remote data
  loss, or local destructive cleanup after incomplete promotion.
- High: can cause denial of service, persistent data inconsistency, or major
  product-contract violation.
- Medium: can cause audit inaccuracies, operational fragility, or incomplete
  evidence.
- Low: cleanup, ergonomics, or hardening that should be done but is not a
  direct exploit path.

