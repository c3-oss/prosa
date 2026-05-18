# Lane Evidence

Lane: 01 - Local store
Status: blocked-on-lane-00
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] `packages/prosa-bundle-v2` implements init/open, shard actors, pack
  writers, epoch lifecycle, and head swap.
- [ ] `packages/prosa-bundle-v2-cas` and `packages/prosa-bundle-v2-raw` are split
  for testability.
- [ ] CAS and raw pack formats enforce zstd window <= 8 MiB.
- [ ] Synthetic bundle scenario writes, seals, reopens, and validates counts.
- [ ] Cold rebuild never writes to live `index/` until the final atomic rename.
- [ ] Invariants I1 and I4 pass.
- [ ] No app code imports bundle v2 yet.

## Implementation Notes

- Source contract: `docs/rearch-2/02-lane-1-local-store.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Raw source roundtrip and CAS dedup tests are required before close.

## Known Risks

- Atomicity, crash recovery, and pack validation failures can corrupt future
  imports or make raw recovery impossible.

## Reviewer Notes

- Pending `prosa-architect` and `ralph-loop-promotion-integrity-reviewer`
  review after material code lands.
