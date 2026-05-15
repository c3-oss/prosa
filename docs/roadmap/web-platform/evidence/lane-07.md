# Lane Evidence

Lane: 07 Search, analytics, and artifacts
Status: open
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] AC-001 Search page supports query, URL-backed filters, pagination, and
  result links.
- [ ] AC-002 Tool-call page supports global and session-scoped audit workflows.
- [ ] AC-003 Analytics page exposes all five existing prosa analytics report
  types.
- [ ] AC-004 Artifact/object previews enforce tenant and verified-data
  authorization.
- [ ] AC-005 Large text outputs are truncated safely with a clear expansion
  path.
- [ ] AC-006 Browser v0 does not expose Parquet/DuckDB/MCP/compile surfaces by
  accident.

## Implementation Notes

- Use Postgres FTS remotely for v0.
- Use lightweight CSS/SVG bars before adding a charting library.
- Keep URL params as the source for search/filter state where specified.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Artifact/object previews require tenant membership and verified ownership.
- Never expose raw object-store keys or undocumented signed URLs.

## Known Risks

- Analytics semantics must match existing SQLite/DuckDB views despite remote API
  response shape changes.

## Reviewer Notes

- Codex review pending.
