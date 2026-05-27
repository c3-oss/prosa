# Lane 10 — Cutover

## Goal

Cut over to v2 in production. Feature flag flips. v1 read/write code paths return 410 Gone. CLI v1 commands print deprecation notices. Web frontend swaps to v2 endpoints. Decommission v1 server code in a follow-up release. Document the rollback plan in case anything goes wrong in the first 48 h after cutover.

## Depends on

- Lanes 0 through 9 all complete and gates passed.
- A staging-environment dress rehearsal of the cutover sequence completed successfully against synthetic production-like data.

## Deliverables

- `PROSA_V2_ENABLED` feature flag wired into all v1 code paths.
- Migration runbook for ops: `docs/runbooks/v2-cutover.md`.
- Decommission PR removing v1 code (deferred to release N+1 post-cutover).
- Customer communication: in-app notice + CLI deprecation warnings + email to active users.
- Post-cutover monitoring dashboard with v2 success metrics.
- Rollback runbook: `docs/runbooks/v2-rollback.md`.

## Tasks

1. **Wire `PROSA_V2_ENABLED` flag.** Every v1 code path (sync, reads, MCP, sessions, search) checks this env var at entry. When `true`:
   - v1 `/api/sync.*` returns `410 Gone` with a redirect to `/v2/promotions/*`.
   - v1 `/trpc/reads.*` returns `410 Gone` with a redirect to `/v2/reads/*`.
   - v1 CLI commands print a deprecation warning + redirect message to stderr; still execute against the old paths until release N+1.
2. **Two-day soft rollout.** Flip `PROSA_V2_ENABLED=true` for 10% of traffic (route by tenant hash). Monitor for 24 h. If no critical regressions, flip to 100%. If issues, flip back to 0% (rollback).
3. **CLI deprecation notices.** Every v1 CLI command (`prosa sync`, `prosa sessions list`, `prosa search`, etc.) prints to stderr on invocation:
   ```
   WARNING: prosa sync is deprecated. Use 'prosa sync-v2' instead.
   See docs/rearch-2/08-lane-7-cli-and-mcp.md for the v1→v2 mapping.
   This command will be removed in prosa v0.9.0.
   ```
4. **Web frontend swap.** Routes already updated in Lane 7. The cutover here just flips the deploy target — v2 web build replaces v1.
5. **Customer communication.** Email to active users 14 days before cutover with:
   - Date of cutover.
   - 1:1 command mapping link.
   - Migration command (`prosa migrate-v2 bundle`).
   - Support contact.
6. **Post-cutover monitoring.** Grafana dashboard with:
   - p95 latency for `/v2/reads/*` per endpoint.
   - p95 wall clock for `prosa sync-v2` (server-side time only).
   - Audit findings count (zero unless drift).
   - GC volume (packs deleted per day).
   - 410 Gone hit rate (should fall to near zero as users adopt v2).
7. **Decommission v1 code.** In release N+1 (after cutover stable for 30 days):
   - Delete `apps/api/src/v1/*`, `apps/cli/src/cli/v1/*`, `packages/prosa-db` (v1), `packages/prosa-sync` (v1).
   - Drop legacy v1 tables (with `legacy_receipt_archive` retained).
   - Remove `PROSA_V2_ENABLED` flag (now always-on).
   - Update CHANGELOG with the breaking-change notice.
8. **Rollback runbook.** Documented at `docs/runbooks/v2-rollback.md`. Single command: revert the feature flag flip. Both v1 and v2 code paths exist in the same binary at cutover; rollback is `PROSA_V2_ENABLED=false` redeploy.

## Cutover sequence (D-day)

```text
T-14 days: Customer email sent.
T-7 days:  Staging dress rehearsal completed. All gates re-verified.
T-1 day:   Release containing both v1 and v2 code paths deployed. Flag at 0%.
T-0:       Flag → 10%. Monitor for 24h.
T+1 day:   Flag → 100%. Monitor for 7 days.
T+7 days:  Stable; declare cutover successful.
T+30 days: Release N+1 with v1 code deleted.
```

## Rollback decision tree

```text
v2 endpoint p95 latency > 2x SLO?
  → flag back to 0%, investigate

Receipt signing failures > 0.1%?
  → flag back to 0%, investigate KMS / signing module

Authority-not-found errors spiking?
  → check remote_authority_v2 population during migration
  → consider partial rollback (selected tenants only)

Audit reporting widespread drift?
  → halt new promotions
  → run full integrity check before unblocking

Compile-all on user laptops failing?
  → CLI rollback: ship a binary that defaults to v1 commands
  → users can opt back into v2 with --v2 flag

Critical correctness bug (data loss, wrong tenant boundaries)?
  → IMMEDIATE flag to 0%
  → post-mortem within 24h
  → no re-cutover until root cause fixed and tested
```

## Tests

| File | Asserts |
|---|---|
| `apps/api/test/v2/cutover/feature-flag.test.ts` | With `PROSA_V2_ENABLED=true`, v1 `/api/sync.*` returns 410 Gone with redirect header. |
| `apps/cli/test/v2/cutover/deprecation.test.ts` | v1 commands print deprecation warning to stderr but execute v1 logic when v2 flag is off. |
| `apps/web/e2e/cutover/route-mapping.test.ts` | All web routes call `/v2/reads/*` endpoints. |
| `apps/api/test/v2/cutover/staged-rollout.test.ts` | 10% traffic routing by tenant hash works deterministically. |
| `apps/api/test/v2/cutover/rollback.test.ts` | Flipping flag from `true` → `false` does not corrupt v2 data; v1 paths resume serving correctly. |

## Gate

The lane (and the project) is complete when:

1. All test files above pass.
2. Staging dress rehearsal complete; cutover sequence executed against staging data without manual intervention.
3. Production cutover at 100% traffic stable for 7 days:
   - No p95 latency regressions vs pre-cutover baseline (or improvements per Lane 6 targets).
   - Receipt signing success rate ≥ 99.99%.
   - Authority refresh hit rate ≥ 95% cached (Lane 6 target).
   - Zero data-loss incidents reported.
4. v1 deprecation warnings displayed to all active CLI users.
5. Release N+1 with v1 code removed merged 30 days after cutover.

## Risks

| Risk | Mitigation |
|---|---|
| Critical correctness bug surfaces in production | Rollback runbook ready; flag flips back in seconds; rollback tested in staging. |
| Customers haven't migrated their bundles in time | Migration tool (Lane 9) is idempotent; CLI prompts user on first v2 invocation if v1 bundle exists. |
| KMS unavailable during cutover | Pre-cutover health check on KMS; abort cutover if KMS p95 > 50 ms or error rate > 0.01%. |
| Postgres partition rebalancing under v2 load | Bench partition hot spots in staging at 5× production traffic. |
| Web frontend cached old endpoints | Cache-bust web build; coordinate with CDN to purge `/api/trpc/*` cached responses. |
| Customer scripts depending on v1 CLI output | Deprecation period: 30 days minimum between cutover and v1 removal. CHANGELOG with full mapping. |

## Unblocks

Nothing — this is the terminal lane. After Lane 10, prosa v2 is the only production. Post-cutover work belongs to a separate roadmap (v2.1, v2.2, etc.).

---

## Post-cutover backlog (v2.x candidates, not in this plan)

Tracked for future planning, not blocking v2.0:

- **Device-key client signing (v2.1).** Schema already supports it (Lane 4). Flip `clientSignatureStatus` from `'absent_v2_0'` to `'verified'`. Estimated 6–10 engineer-weeks for full implementation including cross-signing.
- **ClickHouse for analytics workload (v2.x).** If Postgres FTS or projection scans saturate at scale, evaluate migrating analytics to ClickHouse. The view-name contract (Lane 3 / 6) is stable, so this is a backend swap.
- **Multi-region replication.** Current design is single-region. Cross-region replication for the projection mirror + S3 replication for packs are independent v2.x lines.
- **Server-side session blob pre-shaping.** v2.0 server reconstructs transcripts page-by-page from `projection_*` joins. If transcript latency becomes a hot path, pre-shape blobs at seal time (like local does in Lane 3) and serve from a server-side blob cache.
- **Cross-tenant CAS dedup.** Currently tenant-scoped (Lane 4 / 6). If storage cost becomes painful at scale and the privacy posture can accept a timing oracle, enable storage-layer dedup with documented disclosure.

These are not requirements. They are the recognized v2.x candidates if/when scale or product demands them.
