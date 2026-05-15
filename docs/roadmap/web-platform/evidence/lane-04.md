# Lane Evidence

Lane: 04 Read API v0
Status: open
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] AC-001 API tests cover pagination, filters, tenant isolation, and
  verified-data gating for all new procedures.
- [ ] AC-002 `sessions.detail` can power the console timeline without Markdown
  parsing.
- [ ] AC-003 `search.query` supports global and per-session search with metadata
  filters.
- [ ] AC-004 `analytics.report` exposes all five existing analytics reports
  remotely.
- [ ] AC-005 Artifact/object text access refuses cross-tenant and unverified
  objects.
- [ ] AC-006 Web response types are stable, camelCase, and documented before UI
  work depends on them.

## Implementation Notes

- Add or extend procedures under `apps/api/src/trpc/routers/`.
- Keep database table naming out of frontend-facing types.
- Cursors must encode stable sort tuples, not offsets.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Every read must require tenant membership.
- Rows must be limited to verified promoted projection/object data.
- Object refs must be structured and must not expose raw storage keys.

## Known Risks

- Remote search using Postgres FTS must not degrade into unbounded `ILIKE`
  behavior for v0.

## Reviewer Notes

- Codex review pending.
