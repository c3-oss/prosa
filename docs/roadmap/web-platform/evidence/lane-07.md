# Lane Evidence

Lane: 07 Search, analytics, and artifacts
Status: complete
Owner: Ralph
Commit range: `3a94f9d`

## Acceptance Criteria

- [x] AC-001 `/console/search` supports query, URL-backed filters, cursor
  pagination, and result links. The search form persists `q` and `cursor`
  in the URL so deep links and reloads round-trip cleanly
  (`apps/web/src/routes/console/search.tsx`).
- [x] AC-002 `/console/tool-calls` supports the global audit workflow with an
  "errors only" toggle, cursor pagination, and a session link for each row
  (`apps/web/src/routes/console/tool-calls.tsx`).
- [x] AC-003 `/console/analytics` exposes all five prosa analytics reports
  (`sessions`, `tools`, `errors`, `models`, `projects`) backed by
  `analytics.report` (`apps/web/src/routes/console/analytics.tsx`).
- [x] AC-004 Artifact previews enforce tenant + verified-data authorization
  through the lane-04 `artifacts.getText` procedure. The
  `/console/artifacts/:artifactId` page renders the text payload (bounded
  by API maxBytes) and the binary-notice fallback
  (`apps/web/src/routes/console/artifact.tsx`).
- [x] AC-005 Large text outputs are truncated safely. Search snippets are
  truncated to 320 chars client-side on top of the API's own
  buildSnippet; the artifact view renders bytes only when
  `kind === 'text'` and shows a notice otherwise. Tool-call previews use
  the same truncate helper used everywhere else in the console.
- [x] AC-006 Browser v0 does not expose Parquet/DuckDB/MCP/compile by
  accident — there are no routes, no client procedures, and no UI
  surfaces for those flows.

## Implementation Notes

- Search uses `useSearch` + `useNavigate` from TanStack Router so the URL
  is the canonical state for the query and cursor. Reload, share, or back
  navigation all keep the same view.
- Analytics renders one report at a time via tab toggles. Columns are
  computed from the first row so any future report shape works without UI
  changes.
- Tool calls renders the lane-04 `toolCalls.list` rows directly; the
  errors-only checkbox resets the cursor to keep pagination semantics
  predictable.
- Artifact preview lives at `/console/artifacts/$artifactId` and is the
  only surface that calls `artifacts.getText`. The route component shows
  metadata (objectId, contentType, byte count, truncated flag) plus the
  text payload — only when the API tells us the payload is text.

## Commands Run

```text
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok — 228 modules)
pnpm --filter @c3-oss/prosa-web test                  (ok — 13 tests, no regressions)
pnpm --filter @c3-oss/prosa-web lint                  (ok)
```

## Data / Security Evidence

- Every page is mounted under `/console/*` and bails to `/login` when the
  auth context reports `unauthenticated` (lane 03 guard).
- All queries pass through the tRPC client which forwards
  `x-prosa-tenant-id` and `credentials: 'include'`. The API verifies
  membership server-side and gates rows behind the verified-projection
  manifest, so unauthorised tenants cannot see rows.
- The artifact view shows raw text only when the API marks the payload
  as text; binary content stays metadata-only. No raw storage keys are
  exposed.
- The search query is sent verbatim to the API; the server's ILIKE
  parameterised query handles escaping, and snippets render as plain
  text inside `<p>` — no Markdown/HTML interpretation.

## Known Risks

- Search v0 still uses server-side ILIKE; FTS ranking remains a
  follow-up. Lane 04 documents the upgrade path. The browser ranks
  results in insertion order only.
- Analytics renders raw column names from the report rows. This is
  intentional for v0 (the column set mirrors the existing CLI/analytics
  surface), but a future polish pass can map snake_case to friendlier
  labels.
- Artifact preview does not yet support downloads or detailed binary
  inspection. Lane 08 production-readiness can revisit the download
  affordance once a TTL-bounded signed-URL flow is documented.

## Reviewer Notes

- Codex review of lane 07: search/tool-calls/analytics/artifact pages
  consume only verified, tenant-scoped data from the lane-04 procedures;
  Parquet/DuckDB/MCP/compile remain out of the browser as required. Lane
  08 picks up production readiness, observability, deployment docs, and
  browser E2E.
