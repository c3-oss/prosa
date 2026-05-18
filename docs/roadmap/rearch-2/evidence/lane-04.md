# Lane Evidence

Lane: 04 - Server
Status: out-of-sequence WIP (unaccepted; tracked by CQ-044). The
`packages/prosa-db-v2` scaffold (devices / promotion / packs /
projection / search DDL + apply / assert helpers + 6 pglite-backed
tests) landed alongside the Lane 1 CQ-036..CQ-043 closeout in
`5e5ca20`. It passes its focused gates at `5e4b5e7` but is **not**
counted as accepted Lane 4 progress. The API server, KMS signing,
sync routes, audit/GC cron, and streaming validation remain
unstarted. No new Lane 4 feature work is allowed until Codex
re-review accepts Lane 1.
Owner: Ralph
Commit range: `5e5ca20` (out-of-sequence scaffold; `packages/prosa-db-v2/**` only)

## Acceptance Criteria

- [ ] `packages/prosa-db-v2` defines the Postgres v2 schema and required table
  boot checks.
- [ ] `/v2/*` server code preserves Better Auth and tenant resolution.
- [ ] AWS KMS receipt signing and JWKS publishing are implemented.
- [ ] Streaming pack validation enforces bounded memory and zstd window <= 8
  MiB.
- [ ] One-fleet audit and GC cron skeletons use advisory locks.
- [ ] Production mode fails closed on missing required schema/config.

## Implementation Notes

- Source contract: `docs/rearch-2/05-lane-4-server.md`.
- Domain contract: `.codex/skills/prosa-server-sync/SKILL.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must cover tenant membership checks, signing roundtrip, and streaming
  validator rejection cases.

## Known Risks

- Tenant isolation, object route abuse, production config, and receipt signing
  are release blockers.

## Reviewer Notes

- Pending `prosa-server-sync-specialist` and `ralph-loop-security-reviewer`
  review after material code lands.
