# Lane Evidence

Lane: 04 - Server
Status: blocked-on-lane-00
Owner: Ralph
Commit range:

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
