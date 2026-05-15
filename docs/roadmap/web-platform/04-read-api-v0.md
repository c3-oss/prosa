# Web platform lane 4: Read API v0

This lane defines the canonical web read API. The current API already exposes
remote `sessions`, `search`, and `analytics.summary`, but the console needs a
deeper structured API with pagination, filters, timeline detail, tool calls,
artifact access, and analytics parity with existing prosa features.

## Goals

- Promote `apps/api` into the single backend for web console reads.
- Define stable camelCase response shapes for browser use.
- Provide functional parity with prosa's existing read surfaces where it
  matters for the portal.
- Keep MCP and CLI surfaces as consumers or siblings, not the browser contract.
- Protect every read by authenticated tenant membership and verified promoted
  data.

## Parity target

| Feature | Web API v0 target |
|---|---|
| Session listing | Full parity with CLI list/count, plus cursor pagination and richer filters. |
| Session detail | Better than current remote API: structured timeline, messages, content blocks, tool calls, tool results, artifact refs. |
| Search | Functional parity with `search_docs`, using Postgres FTS in remote v0; Tantivy remains local/sidecar. |
| Tool calls | Global and per-session audit views, matching MCP/CLI intent. |
| Analytics | Expose the five existing analytics reports: sessions, tools, errors, models, projects. |
| Markdown export | Session Markdown preview/export can be added after structured detail; not the primary detail API. |
| Parquet/DuckDB | Out of web v0; remains CLI/export workflow. |
| MCP compile/import | Out of web v0; console is read-first. |

## API procedures

Add or extend tRPC procedures under `apps/api`:

- `sessions.list`
- `sessions.count`
- `sessions.detail`
- `search.query`
- `toolCalls.list`
- `artifacts.getText`
- `analytics.report`

Keep `analytics.summary` as a lightweight dashboard helper, but do not make it
the only analytics endpoint.

## Shared API conventions

Pagination:

```ts
type CursorPageInput = {
  cursor?: string
  limit?: number
}

type CursorPage<T> = {
  rows: T[]
  nextCursor: string | null
}
```

Rules:

- Default limit is `50`.
- Maximum limit is `500` for tables and search.
- Timeline event pages may use maximum `250`.
- Cursor encodes the stable sort tuple, not an offset.
- Sort order must be deterministic with `id` as the final tie-breaker.

Common filters:

```ts
type TimeRangeFilter = {
  since?: string
  until?: string
}

type SourceFilter = {
  sourceKinds?: Array<'codex' | 'claude' | 'gemini' | 'cursor' | 'hermes'>
}
```

Response shape:

- Use camelCase in API responses.
- Keep database/table naming out of frontend types.
- Include `tenantId` only where useful for debugging or URLs; tenant scoping is
  implicit from auth context.
- Include object references as structured refs, never as raw storage keys.

## `sessions.list`

Input:

```ts
type SessionsListInput = CursorPageInput &
  TimeRangeFilter &
  SourceFilter & {
    projectIds?: string[]
    q?: string
    model?: string
    hasErrors?: boolean
    sort?: 'startedAtDesc' | 'startedAtAsc'
  }
```

Row:

```ts
type SessionListRow = {
  id: string
  sourceKind: string
  sourceSessionId?: string | null
  projectId: string | null
  title: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  modelFirst: string | null
  modelLast: string | null
  messageCount: number
  toolCallCount: number
  errorCount: number
  timelineConfidence?: string | null
}
```

Implementation notes:

- Back remote rows with `projection_session` plus aggregate counts.
- Only include rows linked to verified `sync_batch_projection_manifest`.
- Add indexes needed for tenant, source, started timestamp, and title/search.

## `sessions.detail`

Input:

```ts
type SessionDetailInput = {
  sessionId: string
  eventCursor?: string
  eventLimit?: number
}
```

Output:

```ts
type SessionDetail = {
  session: SessionListRow & {
    metadata: unknown
    cwdInitial?: string | null
    gitBranchInitial?: string | null
  }
  events: CursorPage<SessionEvent>
  relatedArtifacts: ArtifactSummary[]
}
```

`SessionEvent` kinds:

- `message`
- `toolCall`
- `toolResult`
- `artifact`
- `system`
- `edge`
- `unknown`

Each event includes:

- `id`
- `ordinal`
- `timestamp`
- `kind`
- `actor`
- `message`
- `toolCall`
- `toolResult`
- `artifacts`
- `preview`
- `metadata`

Rules:

- Return ordered events, not only search snippets.
- Join messages, content blocks, tool calls, tool results, and artifacts where
  possible.
- Use object refs for large content.
- Inline previews are bounded and safe to render.

## `search.query`

Input:

```ts
type SearchQueryInput = CursorPageInput &
  TimeRangeFilter &
  SourceFilter & {
    q: string
    sessionId?: string
    projectIds?: string[]
    roles?: string[]
    toolNames?: string[]
    canonicalToolTypes?: string[]
    fieldKinds?: string[]
    errorsOnly?: boolean
    mode?: 'plain' | 'raw'
  }
```

Output row:

```ts
type SearchHit = {
  id: string
  sessionId: string
  sessionTitle: string | null
  sourceKind: string
  timestamp: string | null
  role: string | null
  toolName: string | null
  fieldKind: string
  snippet: string
  rank: number | null
}
```

Remote implementation:

- Use Postgres FTS for v0, not `ILIKE`.
- Store searchable metadata in columns, not only in text.
- Keep plain mode escaped/safe by default.
- Raw mode is explicit and can be deferred if unsafe.

## `toolCalls.list`

Input:

```ts
type ToolCallsListInput = CursorPageInput &
  TimeRangeFilter &
  SourceFilter & {
    sessionId?: string
    toolNames?: string[]
    canonicalToolTypes?: string[]
    statuses?: string[]
    errorsOnly?: boolean
    pathSubstring?: string
  }
```

Row:

```ts
type ToolCallRow = {
  id: string
  sessionId: string
  sessionTitle: string | null
  sourceKind: string
  name: string
  canonicalType: string | null
  status: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  inputPreview: string | null
  outputPreview: string | null
  errorPreview: string | null
  objectRefs: ObjectRef[]
}
```

## `artifacts.getText`

Input:

```ts
type ArtifactTextInput = {
  artifactId?: string
  objectId?: string
  maxBytes?: number
}
```

Output:

```ts
type ArtifactText = {
  id: string
  objectId: string
  contentType: string | null
  bytesReturned: number
  truncated: boolean
  text: string
}
```

Rules:

- Tenant membership is required.
- The artifact/object must be referenced by verified tenant data.
- Default maximum is conservative.
- Binary content returns metadata and a non-text response, not mojibake.
- Never expose raw object storage keys.

## `analytics.report`

> **Superseded by CQ-006**: in the shipped v0 contract every
> `analytics.report` kind (`sessions`, `tools`, `errors`, `models`,
> `projects`) returns 501 NOT_IMPLEMENTED remotely. The schema below is
> the aspirational contract for a future commit-shape expansion. The
> authoritative shipped behaviour is documented in
> `evidence/lane-08.md` and `correction-queue.md` (CQ-006).

Input:

```ts
type AnalyticsReportInput = {
  report: 'sessions' | 'tools' | 'errors' | 'models' | 'projects'
  since?: string
  until?: string
  sourceKinds?: string[]
  limit?: number
}
```

Output:

```ts
type AnalyticsReport = {
  report: string
  rows: Array<Record<string, unknown>>
  generatedAt: string
}
```

Reports must match existing prosa analytics semantics:

- `session_facts`
- `tool_usage_facts`
- `error_facts`
- `model_usage`
- `project_activity`

## Acceptance criteria

- API tests cover pagination, filters, tenant isolation, and verified-data
  gating for all new procedures.
- `sessions.detail` can power the console timeline without Markdown parsing.
- `search.query` supports global and per-session search with metadata filters.
- `analytics.report` exposes all five existing analytics reports remotely.
  (Superseded by CQ-006: shipped v0 fails closed with 501 for every kind;
  see `evidence/lane-08.md`.)
- Artifact/object text access refuses cross-tenant and unverified objects.
- Web response types are stable and documented in this lane before UI work
  depends on them.

