# Web platform lane 5: Console shell and sessions

This lane builds the first useful authenticated console: dashboard shell,
tenant-aware navigation, session table, filters, and empty states. It should be
valuable even before deep timeline rendering ships.

## Goals

- Implement `/console` and `/console/sessions`.
- Establish the reusable authenticated layout for all console pages.
- Show tenant-scoped session data from `sessions.list`, `sessions.count`, and
  `analytics.summary`.
- Provide filtering and navigation patterns that later pages reuse.
- Make empty states explain the CLI/sync path clearly.

## Console shell layout

Desktop layout:

```text
+----------------------+---------------------------------------------+
| sidebar              | command bar                                 |
| tenant switcher      +---------------------------------------------+
| nav                  | page header                                 |
| sync status          | metrics / filters / table                   |
| user menu            |                                             |
+----------------------+---------------------------------------------+
```

Desktop regions:

- `ConsoleSidebar`: fixed width, full height.
- `TenantSwitcher`: top of sidebar.
- `ConsoleNav`: Sessions, Search, Tool calls, Analytics, Settings.
- `SyncStatusMini`: shows no data, synced, syncing, or error.
- `AccountMenu`: user, role, logout.
- `CommandBar`: global search, provider filter, date range.
- `PageHeader`: title, description, primary action.
- `ContentPanel`: route content.

Mobile layout:

- Top bar with logo, tenant, menu button, search button.
- Sidebar becomes drawer.
- Tables become card lists.
- Filters become a drawer or collapsible panel.

## Dashboard route

Route: `/console`.

Components:

- `DashboardHeader`
- `MetricCardGrid`
- `RecentSessionsPanel`
- `SourceBreakdownPanel`
- `RecentErrorsPanel`
- `GettingStartedEmptyState`

Metrics:

- Total sessions.
- Search docs / indexed evidence.
- Source count.
- Object/artifact count.
- Recent errors when available.

Empty state:

- If authenticated tenant has no promoted data, show:
  - CLI install command.
  - `prosa auth login` guidance.
  - `prosa sync` guidance.
  - Link to docs.
- Do not show fake demo data in the authenticated console.

## Sessions route

Route: `/console/sessions`.

Components:

- `SessionsPage`
- `SessionsToolbar`
- `SessionsFilterBar`
- `SessionsTable`
- `SessionRowCard`
- `SessionSourceBadge`
- `TimelineConfidenceBadge`
- `SessionStatsPills`
- `SessionsEmptyState`
- `SessionsPagination`

Default table columns:

- Started.
- Source.
- Title.
- Model.
- Messages.
- Tool calls.
- Errors.
- Project.
- Duration.

Column behavior:

- Session ID is available in row expansion/copy action, not a primary column.
- Long titles truncate with tooltip.
- Source provider has a compact badge.
- Error count is visually distinct but not alarmist.
- Unknown timestamps sort last and render as `unknown`.

Filters:

- Provider/source.
- Date range.
- Project.
- Model.
- Has errors.
- Text query against title/search metadata.

Sorting:

- Default `startedAtDesc`.
- Allow `startedAtAsc` after API support exists.
- Avoid client-side sorting of incomplete pages.

Interactions:

- Click row opens `/console/sessions/:sessionId`.
- Keyboard `Enter` on focused row opens detail.
- Copy session ID action.
- Open search scoped to this session.
- Filter chips can be removed individually.

## Data loading

Queries:

- `analytics.summary` for dashboard cards.
- `sessions.list` for rows.
- `sessions.count` only where a count is useful; cursor pagination should not
  depend on exact totals.

Loading states:

- Initial page skeleton.
- Table row skeletons.
- Filter changes keep previous data while fetching.
- Empty state only after successful empty response.

Error states:

- 401: route to login.
- 403: show forbidden tenant state.
- Network/API unavailable: show retry panel.
- Rate limited: show retry-after message when present.

## Visual design

Dashboard:

- Dense cards with subtle borders and small mono labels.
- Use accent green for healthy data, amber for warnings, red only for errors.
- Source breakdown uses horizontal bars, not heavy chart dependencies.

Sessions table:

- Dark panel with sticky header.
- Row hover reveals actions.
- Selected/focused row has green left border and subtle background.
- Timestamps and IDs use mono font.

## Acceptance criteria

- Authenticated user can open `/console` and see tenant-scoped summary data.
- User can open `/console/sessions` and browse paginated sessions.
- Filters call the API instead of filtering only the current page.
- Empty tenant clearly explains how to populate data with CLI sync.
- Non-member tenant access shows a forbidden state.
- Layout works on desktop and mobile without horizontal overflow.

