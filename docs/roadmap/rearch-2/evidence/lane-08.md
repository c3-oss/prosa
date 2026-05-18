# Lane Evidence

Lane: 08 - Audit and GC
Status: blocked-on-lane-05
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] Audit cron roles implement hourly, daily, weekly, and monthly cadences
  under advisory locks.
- [ ] GC transitions live packs through tombstone and delete states with grace
  periods.
- [ ] Drift response quarantines packs and degrades affected receipts.
- [ ] Authority responses surface audit status and repair requests.
- [ ] Reads touching quarantined packs return `503 DATA_UNAVAILABLE`.
- [ ] Prometheus metrics cover audit findings and GC volume.

## Implementation Notes

- Source contract: `docs/rearch-2/09-lane-8-audit-and-gc.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must include injected missing/hash-mismatch packs, degraded receipts,
  repair output, and GC safety around open promotions.

## Known Risks

- Unsafe GC can delete live tenant data; weak audit state can allow corrupted
  packs to keep authorizing reads.

## Reviewer Notes

- Pending `ralph-loop-promotion-integrity-reviewer`,
  `ralph-loop-security-reviewer`, and `prosa-server-sync-specialist` review.
