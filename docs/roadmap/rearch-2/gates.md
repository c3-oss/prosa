# rearch-2 Gates

Updated: 2026-05-20 after Codex/governor acceptance of Lane 6.

## Baseline Gates

Run these before claiming any lane or correction is complete:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm lint
git diff --check
```

Use narrower focused gates for the package touched by each slice, then run the
baseline batch before a lane acceptance claim.

## Accepted Lanes

- [x] Lane 0 Foundation accepted.
- [x] Lane 1 Local store accepted with recorded rescopes.
- [x] Lane 2 Importers accepted by Codex/governor on 2026-05-19.
- [x] Lane 3 Derived layer accepted.
- [x] Lane 4 Server accepted by Codex/governor on 2026-05-20.
- [x] Lane 5 Sync protocol accepted by Codex/governor on 2026-05-20.
- [x] Lane 6 Read API accepted by Codex/governor on 2026-05-20.

Lane 6 final API gate:

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  72 passed | 2 skipped (74)
Tests       431 passed | 4 skipped (435)
```

Final focused transcript follow-up:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/transcript-pagination.test.ts
Test Files  1 passed (1)
Tests       7 passed (7)
```

## Lane 7 Completion Gates — CLI and MCP

- [x] `prosa read sessions`, `transcript`, `search`, `tool-calls`,
  `analytics`, and local-only `query` / `export parquet` commands consume the
  Lane 6 read API or fail closed where documented.
- [x] `prosa tui` remains a top-level command and uses the v2 read context where
  applicable. (Top-level remains; v2 context wiring tracked under CQ-149.)
- [x] CLI authority cache implements 60 s TTL, `--refresh`, `--offline`, and
  explicit stop on HTTP 412 (see `apps/cli/test/v2/authority-cache.test.ts`
  and `apps/cli/test/v2/reads-client.test.ts`).
- [~] `prosa mcp serve --authority {auto|local|remote}` pins authority at
  startup. The runtime `prosa.refresh_authority` MCP tool is deferred to
  CQ-149 (restart-to-refresh today).
- [~] MCP tools cover search, sessions, tool calls, analytics, artifact, and
  compile behavior without widening tenant/store authority. The existing
  prosa-core tool set is unchanged; v2 authority-aware tool wiring is
  tracked under CQ-149.
- [~] Web data layer consumes `/v2/reads/*` while preserving route shapes.
  Typed client lives at `apps/web/src/lib/api-v2.ts`; full route-by-route
  migration off tRPC is tracked as a follow-up slice (Lane 7 slice 10b).
- [x] Focused CLI, MCP, and web tests from `docs/rearch-2/08-lane-7-cli-and-mcp.md`
  pass for the authority cache, reads client, read-context routing, and
  web v2 data layer.
- [ ] Manual or E2E smoke proves the documented v1-to-v2 command mapping
  against a live Fastify harness (Lane 7 slice 11).

## Lane 8 Completion Gates — Audit and GC

- [x] Audit cron handlers implement hourly, daily, weekly, and monthly cadences
  under advisory locks.
- [x] Audit detects missing or mismatched packs, quarantines affected packs, and
  degrades affected receipts.
- [x] Authority refresh surfaces `auditStatus` and `repair` for degraded
  receipts.
- [x] `artifacts.getText` returns `503 DATA_UNAVAILABLE` for quarantined pack
  bytes.
- [x] GC transitions unreferenced packs through tombstone and delete phases
  without deleting packs referenced by receipts or open staging rows.
- [x] Metrics exist for audit findings and GC delete/failure volume.
- [x] Focused audit/GC/read tests from
  `docs/rearch-2/09-lane-8-audit-and-gc.md` pass.
- [x] E2E drift and GC scenarios are recorded.

## Lane 9 Completion Gates — Migration

- [x] `prosa migrate-v2 bundle` converts a v1 bundle to v2 from preserved raw
  bytes and aborts before rename on validation failure.
- [x] Migration count validation covers source files, raw records, sessions,
  objects, and search docs according to the Lane 9 policy.
- [x] Migration progress and JSON output are implemented.
- [x] Corrupt or missing raw bytes surface a gap and use the documented
  provider-history fallback when available.
- [x] `prosa migrate-v2 tenant` and `POST /v2/migrate/tenant` re-project a
  tenant remotely with admin-only authorization.
- [x] `legacy_receipt_archive` stores v1 receipts for audit only; v2 reads do
  not accept them as authority.
- [x] Focused migration tests from `docs/rearch-2/10-lane-9-migration.md` pass
  (`pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/`).
- [x] Atomic rename safety and synthetic remote migration E2E evidence are
  recorded.

## Lane 10 Boundary

Lane 10 is not part of the next Ralph loop. CQ-124 and the CQ-124-blocked
projection/search materialization portions of CQ-134 remain Lane 10 scope.
