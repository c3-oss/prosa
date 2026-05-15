# Lane Evidence

Lane: 05 Console shell and sessions
Status: complete
Owner: Ralph
Commit range: `e83027b`

## Acceptance Criteria

- [x] AC-001 Authenticated user can open `/console` and see tenant-scoped
  summary data backed by `analytics.summary`
  (`apps/web/src/routes/console/dashboard.tsx` +
  `components/console/metric-card-grid.tsx` + `source-breakdown.tsx`).
- [x] AC-002 User can open `/console/sessions` and browse paginated sessions
  from `sessions.list` with cursor-based forward/back navigation
  (`apps/web/src/routes/console/sessions.tsx`).
- [x] AC-003 Filters call the API instead of filtering only the current
  page — source toggle chips, title search, and since/until date pickers
  are wired into the `sessions.list` and `sessions.count` query inputs
  (`apps/web/src/components/console/sessions-filter-bar.tsx`).
- [x] AC-004 Empty tenant clearly explains how to populate data with CLI
  sync. Both the dashboard and sessions page render an `EmptyState` card
  with `prosa auth login && prosa sync push` when verified projection
  data is empty.
- [x] AC-005 Non-member tenant access shows a forbidden state. Lane 03
  already wired the `ConsoleLayout` redirect to `/login` on
  `status === 'unauthenticated'`, and read API errors propagate to a
  visible `EmptyState` with the server error message.
- [x] AC-006 Layout works on desktop and mobile without horizontal overflow.
  Console shell styles (`apps/web/src/styles/console.css`) collapse the
  sidebar below `lg` (1024px); tables use sticky headers but do not force
  horizontal scroll on the page.

## Implementation Notes

- Dashboard and sessions queries use tenant-scoped query keys
  (`queryKeys.analyticsSummary`, `queryKeys.sessionsList`,
  `queryKeys.sessionsCount`) so the lane 03 TenantSwitcher invalidates
  console data surgically.
- `sessions.list` queries use `keepPreviousData` so changing filters does
  not blank the table while a new page loads.
- Pagination is cursor-based with a local cursor stack so the user can
  step back without re-querying every previous page (the previous cursor
  is reused). Forward navigation uses `nextCursor` from the API.
- The filter bar reports active source kinds as chip toggles with
  `aria-pressed` so they remain meaningful with keyboard + screen reader
  use. Reset clears all filters and forces a re-query at the first page.

## Commands Run

```text
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok — 225 modules, dist/ produced)
pnpm --filter @c3-oss/prosa-web test                  (ok — 10 tests, +2 for SessionsTable)
pnpm --filter @c3-oss/prosa-web lint                  (ok)
```

## Data / Security Evidence

- All console queries are gated by `tenantProcedure` on the server, so the
  table can never return rows from a tenant the user is not a member of
  even if the client sends a different `x-prosa-tenant-id`.
- `MetricCardGrid` and `SessionsTable` consume the camelCase response
  shape from lane 04 only — no raw database column names or storage keys
  are exposed.
- The empty-state guidance does not link to local-only routes or expose
  any tenant secrets; it points the user back to the CLI sync flow.

## Known Risks

- Pagination resets to the first page on any filter change. That is the
  correct default but a follow-up improvement might persist filters in
  the URL so deep links remain stable across reloads — lane 07 covers
  URL-backed filters for search/analytics and can extend the pattern to
  sessions if needed.
- Search title filter is client-supplied free text passed to the server's
  ILIKE filter; no FTS ranking yet. Lane 07 considers FTS upgrade.

## Reviewer Notes

- Codex review of lane 05: dashboard + sessions table consume verified
  promoted data only, filters call the API, and empty/error states map to
  roadmap intent. Lane 06 picks up the structured session detail timeline.
