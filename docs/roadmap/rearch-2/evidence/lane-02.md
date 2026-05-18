# Lane Evidence

Lane: 02 - Importers
Status: blocked-on-lane-01
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] `packages/prosa-importers-v2` implements `LogicalImportUnit`,
  Reserve-before-parse, `GraphResolver`, and provider modules.
- [ ] Codex, Claude Code, Cursor, Gemini, and Hermes fixture corpora import into
  bundle v2.
- [ ] Re-running compile over the same fixtures is a no-op.
- [ ] Cross-provider and subagent graph resolution populates
  `parent_resolution`.
- [ ] Hermes and Gemini multi-source merge behavior is covered by tests.
- [ ] `compile-v2` and `compile-all-v2` are added alongside v1 commands.
- [ ] Invariants I2 and I3 pass.

## Implementation Notes

- Source contract: `docs/rearch-2/03-lane-2-importers.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Provider fixtures must avoid real user history and must preserve raw records
  with source locators.

## Known Risks

- Reservation TTL, merge tie-breakers, and graph fixups are likely correctness
  hot spots.

## Reviewer Notes

- Pending `prosa-importer-specialist` and `prosa-architect` review after
  material code lands.
