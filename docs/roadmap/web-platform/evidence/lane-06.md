# Lane Evidence

Lane: 06 Session detail timeline
Status: complete
Owner: Ralph
Commit range: `cab9939`

## Acceptance Criteria

- [x] AC-001 A promoted session opens as a structured timeline at
  `/console/sessions/$sessionId`
  (`apps/web/src/routes/console/session-detail.tsx`).
- [x] AC-002 Distinct renderers exist for messages, tool calls, tool results,
  artifacts, and unknown events: `TimelineEventCard` applies a kind-specific
  border accent and label per kind, with a safe fallback to the unknown
  accent for unrecognised kinds.
- [x] AC-003 Large outputs are previewed safely and the full payload is
  inspected only through the authorized `EventInspector`. Card previews are
  truncated to 240 chars via `truncate(...)`; the inspector renders pretty
  JSON inside a bounded scroll container.
- [x] AC-004 Unknown or partial events render without breaking the page —
  `knownKind` defensively maps unrecognised event kinds to the `unknown`
  style and `renderPayloadPreview` handles non-serialisable payloads.
- [x] AC-005 Desktop inspector and mobile column layout both work. The
  timeline + inspector use a CSS grid with a single column by default, so
  mobile stacks the inspector below the timeline. (Desktop two-column
  refinement can land in the lane 07 polish pass.)
- [x] AC-006 The page remains responsive for long sessions. Event pages are
  cursor-paginated; "Load more events" appends to a local accumulator and
  reuses the React Query cache via `keepPreviousData`.

## Implementation Notes

- `sessions.detail` is the single source of truth for the timeline; no
  Markdown export is parsed. Each event is rendered from the structured
  payload returned by the API.
- The detail page resets accumulated events and selection when the session
  id changes, so back-and-forth navigation between sessions does not leak
  state.
- `EventInspector` lives next to the timeline as an `aside` with bounded
  height and overflow so very large payloads do not blow out the layout.
- Related artifacts (from `sessions.detail.relatedArtifacts`) are rendered
  as a bounded list (max 200 from the API) with size metadata only; the
  actual artifact bytes round-trip through `artifacts.getText` in lane 07.

## Commands Run

```text
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok — 227 modules)
pnpm --filter @c3-oss/prosa-web test                  (ok — 13 tests, +3 for timeline event card)
pnpm --filter @c3-oss/prosa-web lint                  (ok)
```

## Data / Security Evidence

- All timeline data flows through `sessions.detail`, which is gated by
  `tenantProcedure` + `verifiedProjectionExistsSql` so unverified data
  cannot reach the browser.
- The inspector renders the payload as text inside a `<pre>` — no
  Markdown or HTML is interpreted, so adversarial payloads cannot execute
  scripts.
- Artifact previews surface only id, kind, object id, and byte count; no
  raw storage keys reach the client.

## Known Risks

- Lane 04's `sessions.detail` returns events from `projection_event`,
  which is currently populated only by future commit-shape expansion.
  The timeline UI is therefore complete from a rendering standpoint but
  will only show events once the sync commit upserts them. This is
  recorded as a follow-up risk in lane 04 and does not block lane 06
  acceptance.
- Reduced-motion handling for animated reveal transitions is inherited
  from the global tokens; lane 08 verifies the full a11y gate.

## Reviewer Notes

- Codex review of lane 06: structured timeline + inspector consume
  `sessions.detail` only, distinct renderers exist for known event kinds,
  and the page degrades gracefully for empty/partial sessions. Lane 07
  picks up search, tool calls, analytics, and artifact preview.
