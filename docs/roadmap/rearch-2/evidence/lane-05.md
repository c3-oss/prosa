# Lane 5 Evidence - Sync protocol

Status: prepared; blocked until Lane 4 acceptance.

Lane 5 may start only after Lane 4 has five fresh clean 180-second
stabilization cycles and is accepted by Codex/governor.

Core scope after Lane 4 acceptance:

- Implement the four-call promotion protocol:
  `BeginPromotion` -> inventory/object uploads -> `SealPromotion` ->
  `GetReceipt`.
- Add CLI `prosa sync-v2` with retries, resume checkpointing, `--no-resume`,
  dry-run/json flags as specified in `docs/rearch-2/06-lane-5-sync-protocol.md`.
- Preserve one-way local-bundle-to-remote sync; the server must not derive data
  the client did not promote.
- Keep object identity as canonical BLAKE3 over original bytes; transport hash
  remains separate.
- Apply projection/search rows only through the seal transaction.
- Prove tenant/device/object authorization parity on every route.

Required support:

- Inventory fixtures/builders, focused route tests, signer/JWKS helpers, local
  object-store or MinIO harness setup, and resume/no-op test fixtures.
- Docker-backed E2E only when the promotion protocol path is wired.

Premature/later-lane surface:

- Lane 6 read API expansion, Lane 7 CLI/MCP read surfaces, Lane 8 audit/GC
  implementation beyond existing cron skeleton, migration/cutover work, and
  broad dashboards/diagnostics.

Initial Lane 5 gates to collect:

```text
pnpm --filter @c3-oss/prosa-api test
pnpm --filter @c3-oss/prosa test
pnpm typecheck
pnpm lint
git diff --check
```

Docker E2E evidence must be added before Lane 5 acceptance.
