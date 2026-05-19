# Lane Evidence

Lane: 03 - Derived layer
Status: blocked-on-cq-083
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] `packages/prosa-derived-v2` implements Tantivy local indexing, session
  blob pack writer/reader, analytics views, and compaction.
- [ ] Session blob pages obey byte and message constraints.
- [ ] Analytics view names and column shapes match the v1 contract.
- [ ] Compaction preserves the logical row set and does not change
  `bundleRoot`.
- [ ] `index-v2` and export/analytics surfaces are available as planned.

## Implementation Notes

- Source contract: `docs/rearch-2/04-lane-3-derived-layer.md`.
- Lane 3 must not be committed while `CQ-083` is open. Untracked
  `packages/prosa-derived-v2/` work, if present, remains unaccepted WIP and
  must not be mixed into the Lane 2 closeout commit.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Derived artifacts are never authoritative; evidence must show rebuildability
  from canonical projection rows.

## Known Risks

- Column drift in analytics and oversized transcript pages can break downstream
  CLI, MCP, and web reads.

## Reviewer Notes

- Pending `prosa-cli-search-specialist` and `prosa-architect` review after
  material code lands.
