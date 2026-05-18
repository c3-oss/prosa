# Lane Evidence

Lane: 05 - Sync protocol
Status: blocked-on-lane-04
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] BeginPromotion, UploadSegment, UploadObjectPack, SealPromotion, and
  GetReceipt are implemented end to end.
- [ ] SealPromotion swaps receipt, authority, search generation, pack grants,
  and staging status in one Postgres transaction.
- [ ] `sync-v2` client supports no-op fast path, resume, adaptive concurrency,
  dry run, and JSON output.
- [ ] Fresh promotion, no-op promotion, `--no-resume`, and receipt verification
  pass in the Docker harness.
- [ ] Lint/test guard proves only the seal path writes authority tables.
- [ ] Invariant I5 passes and I1-I4 remain green.

## Implementation Notes

- Source contract: `docs/rearch-2/06-lane-5-sync-protocol.md`.
- Domain contract: `.codex/skills/prosa-server-sync/SKILL.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must include Docker-backed API, Postgres, object storage, CLI sync,
  receipt verification, and resume behavior.

## Known Risks

- Any async gap in authority swap, receipt grants, or projection materialization
  can leak partial state to readers.

## Reviewer Notes

- Pending `prosa-server-sync-specialist`,
  `ralph-loop-promotion-integrity-reviewer`, `ralph-loop-security-reviewer`,
  and `ralph-loop-e2e-gate-runner` review.
