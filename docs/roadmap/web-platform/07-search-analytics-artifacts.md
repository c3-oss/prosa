# Web platform lane 7: Search, analytics, and artifacts

This lane rounds out the console's read surfaces beyond session browsing:
global search, tool-call audit, analytics reports, and secure artifact/object
preview. It brings the portal close to parity with prosa's existing search,
analytics, export, and MCP read capabilities where those belong in a browser.

## Goals

- Implement `/console/search`.
- Implement `/console/tool-calls`.
- Implement `/console/analytics`.
- Implement artifact/object preview flows.
- Expose the five analytics reports already defined by prosa.
- Keep Parquet/DuckDB and MCP management outside web v0.

## Search page

Route: `/console/search`.

Components:

- `SearchPage`
- `SearchInput`
- `SearchFacetBar`
- `SearchResultList`
- `SearchResultCard`
- `Snippet`
- `SearchEmptyState`
- `SavedFilterSummary`

Filters:

- Query text.
- Provider/source.
- Date range.
- Session.
- Project.
- Role.
- Tool name.
- Canonical tool type.
- Field kind.
- Errors only.

Result card:

- Snippet with highlight.
- Session title and source.
- Timestamp.
- Role/tool metadata.
- Field kind.
- Button to open session at matching event when event mapping is available.

Behavior:

- Debounce text input.
- Submit with Enter.
- Keep query state in URL params.
- Pagination uses cursor from `search.query`.
- Empty state distinguishes "no query" from "no results".

Backend:

- Remote v0 uses Postgres FTS over `search_doc`.
- Search metadata columns must support filters without parsing text blobs.
- Ranking/snippet behavior should be deterministic enough for tests.
- Tantivy remains local/sidecar until remote Postgres FTS is insufficient.

## Tool-call audit page

Route: `/console/tool-calls`.

Components:

- `ToolCallsPage`
- `ToolCallsToolbar`
- `ToolCallsTable`
- `ToolCallStatusBadge`
- `ToolNameCell`
- `ToolPreviewCell`
- `ToolCallInspector`

Columns:

- Time.
- Tool.
- Canonical type.
- Status.
- Session.
- Duration.
- Input preview.
- Output/error preview.

Filters:

- Provider/source.
- Date range.
- Tool name.
- Canonical type.
- Status.
- Errors only.
- Path substring.
- Session.

Use cases:

- Find every failed command.
- Find every tool call touching a path.
- Audit all web/search/file tools used by agents.
- Jump from a tool call to its session timeline.

## Analytics page

> **Superseded by CQ-006**: in the shipped v0 contract every
> `analytics.report` kind returns 501 remotely. The `/console/analytics`
> page renders the fail-closed error banner for every tab. The
> aspirational report layout below applies only after the promotion
> manifest grows verified entries for the auxiliary tables those views
> join. See `evidence/lane-08.md` and `correction-queue.md` (CQ-006).

Route: `/console/analytics`.

Components:

- `AnalyticsPage`
- `ReportTabs`
- `ReportFilterBar`
- `ReportTable`
- `MiniBar`
- `MetricCard`
- `ReportEmptyState`

Reports:

- `sessions`: source, project, model, counts, duration, confidence.
- `tools`: tool name/type, call counts, errors, latency/duration when known.
- `errors`: error previews, sessions, tools, timestamps.
- `models`: model usage by session/message/turn where available.
- `projects`: project activity, latest session, counts, low-confidence rows.

Rules:

- Use `analytics.report` for table data.
- Use lightweight CSS/SVG bars before adding a charting library.
- Keep raw report rows available as JSON copy/export only after access rules are
  defined.
- Match semantics of existing SQLite/DuckDB analytics views.

## Artifact and object preview

Entry points:

- Session timeline object refs.
- Tool result output refs.
- Artifact chips.
- Search result object refs when available.

Components:

- `ArtifactPreviewPage`
- `ObjectPreviewDrawer`
- `ObjectMetadataPanel`
- `TextObjectViewer`
- `BinaryObjectNotice`
- `DownloadAction`
- `RedactionNotice`

Rules:

- API authorizes every read by tenant membership and verified ownership.
- Text preview has byte limits and truncation notice.
- Binary preview shows metadata by default.
- Downloads require explicit user action.
- Never expose raw object-store keys or signed URLs unless their TTL and tenant
  authorization model are documented.
- Content that looks like secrets should not be automatically redacted in v0
  unless a deterministic redaction policy exists; instead provide clear
  sensitive-data warnings.

## Markdown export

Session Markdown export is useful but secondary to structured detail.

Recommended v0 behavior:

- Add "Copy Markdown" or "Download Markdown" only after `sessions.detail` is
  stable.
- Generate Markdown server-side from verified tenant data.
- Preserve provenance: source, session ID, timestamps, cwd, model, confidence,
  and object refs.

Out of scope for this lane:

- Parquet export from the browser.
- DuckDB browser queries.
- MCP server management.
- Browser-triggered compile/import.

## Acceptance criteria

- Search page supports query, URL-backed filters, pagination, and result links.
- Tool-call page supports global and session-scoped audit workflows.
- Analytics page exposes all five existing prosa analytics report types.
- Artifact/object previews enforce tenant and verified-data authorization.
- Large text outputs are truncated safely with a clear expansion path.
- Browser v0 does not expose Parquet/DuckDB/MCP/compile surfaces by accident.

