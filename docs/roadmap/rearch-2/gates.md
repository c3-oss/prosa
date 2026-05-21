# rearch-2 Gates

Updated: 2026-05-21 after final-validation closure of CQ-155, CQ-156, CQ-161.

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
- [x] Lane 7 CLI and MCP accepted by Codex/governor on 2026-05-20.

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
- [x] `prosa mcp serve --authority {auto|local|remote}` pins authority at
  startup; `prosa.refresh_authority` MCP tool registered when the
  remote context is resolved (CQ-149 closed at `a3d25c8`).
- [x] MCP tools cover search, sessions, tool calls, analytics, artifact, and
  compile behavior without widening tenant/store authority; the
  `prosa.refresh_authority` tool is now exposed via
  `packages/prosa-core/src/mcp/tools.ts` when `onRefreshAuthority` is
  passed.
- [x] Web data layer consumes `/v2/reads/*` while preserving route shapes
  (CQ-153 closed at `b52a837`). Seven routes migrated to `apiV2`
  (sessions, search, tool-calls, analytics, session-detail, dashboard,
  artifact); cas-text + 4 dashboard widgets render explicit pending-v2
  empty states without legacy tRPC fallback. New v2 analytics endpoints
  (activity / tokens-by-agent / agent-vs-subagent) and an objectId-keyed
  artifact lookup are tracked as a separate CQ-153 follow-up; they are
  not blocking for Lane 7.
- [x] Focused CLI, MCP, and web tests from `docs/rearch-2/08-lane-7-cli-and-mcp.md`
  pass for the authority cache, reads client, read-context routing, and
  web v2 data layer.
- [x] Manual or E2E smoke proves the documented v1-to-v2 command mapping
  (CQ-154 closed). `apps/cli/test/v2/read-sessions-e2e.test.ts` boots a
  minimal Fastify with the Lane 6 v2 read plugin against a v2-only
  PGlite, stubs Better Auth's `getSession` to bypass the CQ-124 schema
  conflict, seeds `remote_authority_v2` + `projection_session`, and
  drives `prosa read sessions` end-to-end via a stub fetch adapter that
  routes through `app.inject(...)`. Both the list and `--count` smoke
  cases pass.

## Lane 8 Completion Gates — Audit and GC

Lane 8 awaiting governor acceptance. CQ-155, CQ-156, CQ-157 closed
after the final-validation round.

- [x] Audit cron handlers implement hourly, daily, weekly, and monthly cadences
  under advisory locks and are wired into API startup/config (CQ-156:
  `intervalScheduler` wakes every minute and only fires each handler when its
  `cadenceForExpression(...)` window has elapsed; cadence is also gated by
  durable `pack_audit_state.last_full_hash_at` /
  `pack_gc_state.first_unreferenced_at` columns so a restart-reset of the
  per-process timer is bounded by the durable cadence — governor-rescoped
  in `evidence/lane-08.md` and `apps/api/src/cron/wire.ts`).
- [x] Audit detects missing or mismatched packs with the catalog digest
  algorithm (CQ-157: monthly cadence now BLAKE3, normalised against
  `remote_pack.byte_hash`; `audit-detects-mismatch.test.ts`).
- [x] Authority refresh surfaces `auditStatus` and `repair` for degraded
  receipts.
- [x] `artifacts.getText` returns `503 DATA_UNAVAILABLE` for quarantined pack
  bytes.
- [x] GC transitions unreferenced packs through tombstone and delete phases
  without deleting packs referenced by receipts or open staging rows, including
  references that appear after tombstone and before delete (CQ-155 final fix:
  GC's catalog delete tx AND seal-promotion's grant insert both take
  `FOR UPDATE` on the `remote_pack` row, serializing the two paths. The GC
  staging guard now joins `promotion_uploaded_pack` so production-shape
  staging linkage is honored even when `head_json.pack_digests` is empty.
  The corrected `gc-rechecks-before-delete.test.ts` "final-review race"
  proves a grant inserted before phase 3 keeps the pack live and bytes
  intact).
- [x] Metrics exist for audit findings and GC delete/failure volume.
- [x] Focused audit/GC/read tests from
  `docs/rearch-2/09-lane-8-audit-and-gc.md` pass (`test/v2/cron/` 11 files,
  23 tests; full API suite 90 files, 470 passed).
- [x] E2E drift and GC scenarios recorded under `evidence/lane-08.md`,
  including post-tombstone reference revalidation, the production-staging
  guard, and the corrected race semantics.

## Lane 9 Completion Gates — Migration

Lane 9 awaiting governor acceptance. CQ-158, CQ-159, CQ-160, CQ-161
closed after the final-validation round. Focused local migration gate:
`pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/` → 5 files,
13 tests passed.

- [x] `prosa migrate-v2 bundle` converts a v1 bundle to v2 from preserved raw
  bytes without mutating the v1 source and remains recoverable across rename
  interruption (CQ-161: snapshot-verify aborts BEFORE rename when raw_sources
  or db mutates mid-flight; marker file enables atomic recovery; non-empty
  non-migration-owned `newPath` is REFUSED instead of being recursively
  removed; `bundle-read-only-and-recovery.test.ts` — 5 tests pass).
- [x] Migration count validation covers source files, raw records, sessions,
  objects, and search docs according to the Lane 9 policy.
- [x] Migration progress and JSON output are implemented.
- [x] Corrupt or missing raw bytes surface a gap and use the documented
  provider-history fallback when available; same-size BLAKE3 mismatch is
  rejected as `raw_bytes_corrupted` (CQ-158 governor follow-up).
- [x] `prosa migrate-v2 tenant` and `POST /v2/migrate/tenant` re-project a
  tenant remotely with admin-only authorization and publish authority only
  after Lane 6 read surfaces can consume the migrated projections (CQ-158:
  `projection_session` populated under the same `(tenant,store,receipt)`
  triple Lane 6 reads gate on; `tenant-reads-e2e.test.ts`).
- [x] `legacy_receipt_archive` stores v1 receipts for audit only; v2 reads do
  not accept them as authority, including multi-store migrations (CQ-159:
  `tenant-multistore.test.ts` now drives the PUBLIC
  `/v2/stores/<store>/authority` route per store and asserts the per-store
  receipt payload; tenant-wide bundleRoot provenance documented in
  `tenant.ts`).
- [x] Focused migration tests from `docs/rearch-2/10-lane-9-migration.md` pass
  (`pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/` 5 files,
  10 tests; `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/`
  5 files, 13 tests). Mutation regression tampers a raw_sources file (not
  the v1 manifest) so the v1 opener runs cleanly and the snapshot-reverify
  catches the mutation with `MigrationError(stage='validate')`.
- [x] Atomic rename safety, server-owned receipt provenance (CQ-160: body
  `serverRegion` rejected; `tenant-receipt-provenance.test.ts`), and
  synthetic remote migration E2E evidence recorded under
  `evidence/lane-09.md`. 1.4 GB perf gate explicitly rescoped to a Lane 10
  follow-up.

## Lane 10 Boundary

Lane 10 is not part of the next Ralph loop. CQ-124 and the CQ-124-blocked
projection/search materialization portions of CQ-134 remain Lane 10 scope.
