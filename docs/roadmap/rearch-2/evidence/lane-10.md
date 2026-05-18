# Lane Evidence

Lane: 10 - Cutover
Status: blocked-on-lane-09
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] `PROSA_V2_ENABLED` gates v1 API, CLI, read, sync, MCP, and web paths.
- [ ] v1 API paths return 410 with redirects when the flag is enabled.
- [ ] v1 CLI commands emit deprecation notices while executing old behavior
  until removal.
- [ ] Cutover and rollback runbooks exist under `docs/runbooks/`.
- [ ] Staged rollout by tenant hash is deterministic and tested.
- [ ] Post-cutover monitoring dashboard and customer communication artifacts are
  documented.
- [ ] Release N+1 v1 deletion plan is recorded but not prematurely executed.

## Implementation Notes

- Source contract: `docs/rearch-2/11-lane-10-cutover.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must include staging dress rehearsal, rollback test, and production
  stability criteria before final project completion.

## Known Risks

- Critical correctness, latency, KMS, authority, and customer-script regressions
  require immediate rollback via feature flag.

## Reviewer Notes

- Pending final Codex gate review plus security, remote-read, promotion
  integrity, E2E, and refactor reviewer passes.
