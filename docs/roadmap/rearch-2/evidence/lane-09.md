# Lane Evidence

Lane: 09 - Migration
Status: blocked-on-lane-05
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] `prosa migrate-v2 bundle` converts a v1 bundle to v2 by re-projecting
  preserved raw bytes.
- [ ] Count validation blocks atomic rename on mismatches.
- [ ] Corruption fallback and provider-directory recompile path are documented
  and tested.
- [ ] `prosa migrate-v2 tenant` and `POST /v2/migrate/tenant` migrate promoted
  tenants and archive legacy receipts.
- [ ] Atomic rename safety survives simulated interruption.
- [ ] Reference fixture migration completes within the lane target.

## Implementation Notes

- Source contract: `docs/rearch-2/10-lane-9-migration.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must compare v1 and v2 source file, raw record, session, object, and
  search doc counts and prove v1 remains intact on failure.

## Known Risks

- Missing raw bytes, disk pressure, partial promotion state, and count drift are
  the main migration blockers.

## Reviewer Notes

- Pending `prosa-importer-specialist`,
  `ralph-loop-promotion-integrity-reviewer`, and
  `ralph-loop-remote-read-reviewer` review.
