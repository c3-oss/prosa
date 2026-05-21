# rearch-2 Gates

Updated: 2026-05-21 after final governor review rejected the CQ-155 GC-wins production-path proof.

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

Lane 8 is ready for governor acceptance. CQ-156 closed under the narrower
documented cadence rescope. CQ-155 closed with the full suite of
seal-vs-GC regressions: inline-SQL ordering invariants
(`gc-seal-interleaving.test.ts`), production `sealPromotion()` pre-tx
fail-closed (PACK_BYTES_MISSING), production `sealPromotion()` inside-tx
rollback when GC's catalog delete lands between
`verifyLinkedPackBytes` and the FOR UPDATE recheck
(`gc-seal-production-interleaving.test.ts`), and the seal-wins case
where GC reverts to `live` (same file).

- [x] Audit cron handlers implement hourly, daily, weekly, and monthly cadences
  under advisory locks and are wired into API startup/config (CQ-156:
  `intervalScheduler` wakes every minute and only fires each handler when its
  `cadenceForExpression(...)` window has elapsed; cadence is durably gated for
  monthly full-byte rehash via `pack_audit_state.last_full_hash_at` and for GC
  via `remote_pack.ingested_at` + `pack_gc_state.first_unreferenced_at`; hourly,
  daily, and weekly audit sampling may do bounded duplicate work after process
  or fleet restart, bounded by advisory locks and the per-tenant sampling caps,
  and does NOT publish authority or delete bytes — governor-accepted narrower
  rescope, recorded explicitly in `apps/api/src/cron/wire.ts` and
  `evidence/lane-08.md`).
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
  `FOR UPDATE` on the `remote_pack` row, serializing the two paths.
  `gc-seal-interleaving.test.ts` covers the two two-transaction orderings —
  GC-wins (seal aborts before any receipt/authority/grant is visible) and
  seal-wins (GC reverts to live) — plus production-shape
  `promotion_uploaded_pack` reversion for both `tombstone_pending` and
  `delete_pending`. `gc-seal-production-interleaving.test.ts` adds three
  production-path regressions that drive the same orderings through the
  real `sealPromotion()` entry point: GC-wins pre-tx fail-closed
  (PACK_BYTES_MISSING; staging restored to open), GC-wins inside-tx
  rollback where `verifyLinkedPackBytes` passes but the catalog row is
  deleted before the FOR UPDATE recheck inside the seal tx (assertion:
  zero receipt / authority / search_generation / grant visible; staging
  restored), and seal-wins reversion. The existing
  `gc-rechecks-before-delete.test.ts` continues to pin the
  post-tombstone grant/staging revert paths).
- [x] Metrics exist for audit findings and GC delete/failure volume.
- [x] Focused audit/GC/read tests from
  `docs/rearch-2/09-lane-8-audit-and-gc.md` pass (`test/v2/cron/` 13 files,
  31 tests).
- [x] E2E drift and GC scenarios recorded under `evidence/lane-08.md`,
  including post-tombstone reference revalidation, the production-staging
  guard, the two-transaction seal-vs-GC interleavings (both inline-SQL and
  via real `sealPromotion()` pre-tx + inside-tx), and the narrower
  CQ-156 cadence rescope.

## Lane 9 Completion Gates — Migration

Lane 9 is ready for governor acceptance. CQ-161 closed with the
temp-copy read-only proof, the content-hashed snapshot regression
for same-name/same-size raw_sources corruption, and the marker-owned
pre-archive cleanup regression.

- [x] `prosa migrate-v2 bundle` converts a v1 bundle to v2 from preserved raw
  bytes without mutating the v1 source and remains recoverable across rename
  interruption (CQ-161: migration copies the v1 bundle to a temp directory and
  opens THAT through the mutable opener, so the operator's source is never
  opened mutably; content-hashed snapshot detects same-name/same-size
  raw_sources corruption and aborts BEFORE archive with
  `MigrationError(stage='validate')`; marker file enables atomic recovery
  including the pre-archive crash state where the marker, oldPath, and a
  non-empty newPath all exist; non-empty non-marker-owned `newPath` is REFUSED
  instead of being recursively removed; `bundle-read-only-and-recovery.test.ts`
  7 tests).
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
  5 files, 15 tests). Mid-flight mutation regression now uses a deterministic
  `_beforeResnapshot` test hook (no setTimeout race) and tampers a raw_sources
  file (not the v1 manifest) so the v1 opener — which runs against the
  temp-copy — succeeds cleanly while the post-reproject resnapshot of the
  operator's source catches the mutation with
  `MigrationError(stage='validate')`. A new same-name/same-size content
  corruption regression overwrites a raw_sources file with same-length but
  different bytes and proves the content-hashed snapshot catches it.
- [x] Atomic rename safety, server-owned receipt provenance (CQ-160: body
  `serverRegion` rejected; `tenant-receipt-provenance.test.ts`), and
  synthetic remote migration E2E evidence recorded under
  `evidence/lane-09.md`. 1.4 GB perf gate explicitly rescoped to a Lane 10
  follow-up.

## Lane 10 Boundary

Lane 10 is not part of the next Ralph loop. CQ-124 and the CQ-124-blocked
projection/search materialization portions of CQ-134 remain Lane 10 scope.
