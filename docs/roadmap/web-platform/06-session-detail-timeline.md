# Web platform lane 6: Session detail timeline

This lane builds the core console experience: inspecting what happened inside a
session. The page must show user messages, agent messages, tool calls, tool
results, errors, content blocks, artifacts, and object references in a structured
timeline.

## Goals

- Implement `/console/sessions/:sessionId`.
- Use `sessions.detail` as the primary data source.
- Render an ordered timeline without relying on Markdown export.
- Provide an inspector for tool inputs, outputs, artifacts, metadata, and raw
  object previews.
- Handle long sessions and large outputs without freezing the browser.

## Page layout

Desktop:

```text
+---------------------------------------------------------------+
| session header: title, source, model, time, counts, actions    |
+-----------------------------------------+---------------------+
| timeline                                | inspector           |
| message/tool/result cards               | selected event      |
| incremental event loading               | object previews     |
+-----------------------------------------+---------------------+
```

Mobile:

- Header stays at top.
- Timeline is full width.
- Inspector opens as a full-screen drawer.
- Event action menus use bottom sheets.

## Components

Page components:

- `SessionDetailPage`
- `SessionHeader`
- `SessionMetaGrid`
- `SessionActionBar`
- `TimelineViewport`
- `TimelineLoadMore`
- `SessionInspector`

Timeline components:

- `TimelineRail`
- `TimelineEventCard`
- `MessageEvent`
- `ToolCallEvent`
- `ToolResultEvent`
- `ArtifactEvent`
- `SystemEvent`
- `UnknownEvent`
- `TimestampMarker`
- `ActorBadge`
- `EventStatusBadge`

Content components:

- `MessageBubble`
- `ContentBlockRenderer`
- `MarkdownText`
- `PlainTextBlock`
- `JsonTree`
- `CodeBlock`
- `DiffBlock`
- `CommandBlock`
- `ToolInputPreview`
- `ToolOutputPreview`
- `ArtifactChip`
- `ObjectRefButton`
- `TruncatedContentNotice`

Inspector components:

- `EventInspector`
- `ToolCallInspector`
- `ToolResultInspector`
- `ArtifactInspector`
- `ObjectPreviewDrawer`
- `RawMetadataPanel`

## Rendering rules

Messages:

- User messages align with a user-colored left accent.
- Agent messages use the default timeline card style.
- System/developer messages are compact and visually separate.
- Markdown rendering must be sanitized.
- Code blocks use mono font and horizontal scroll inside the card.

Tool calls:

- Show tool name, canonical type, status, start time, duration, and input
  preview.
- Inputs render as JSON tree when structured.
- Failed calls or failed results show an error accent and error preview.
- Long inputs remain collapsed by default.

Tool results:

- Show status, finish time, output preview, and object refs.
- Large output never renders fully inline by default.
- Full output opens through `artifacts.getText` or object preview endpoint.

Artifacts:

- Render artifact chips inline where referenced.
- Click opens inspector or `/console/artifacts/:artifactId` if stable URL is
  warranted.
- Binary artifacts show metadata and download/preview affordance only if the
  API authorizes it.

Unknown events:

- Keep them visible.
- Render event kind, timestamp, preview, and raw metadata.
- Do not crash when projection data is incomplete.

## Data model expectations

`sessions.detail` must return:

- Session summary.
- Cursor-paginated ordered events.
- Event kind and ordinal.
- Message payload and content blocks.
- Tool call payload and result refs.
- Artifact summaries.
- Object refs for large content.
- Metadata for debugging and future renderer improvements.

Frontend state:

- Selected event ID.
- Expanded event IDs.
- Loaded event pages.
- Active inspector tab.
- Object preview cache keyed by object/artifact ref.

## Long-session behavior

- Initial load fetches first event page.
- User can load more events.
- If sessions commonly exceed thousands of events, add virtualization with
  `@tanstack/react-virtual`.
- Preserve scroll position when expanding cards.
- Avoid rendering full JSON or full tool output in the timeline.

## Actions

Session-level:

- Copy session ID.
- Open scoped search.
- Export Markdown when API support exists.
- Copy link.

Event-level:

- Copy event ID.
- Copy message/tool text preview.
- Open raw metadata.
- Open object/artifact preview.
- Search within this session for selected text.

## Accessibility

- Timeline cards are keyboard focusable.
- Focused event can open inspector with `Enter`.
- Escape closes inspector/drawer.
- Cards have semantic headings.
- Status is represented by text and shape/color, not color alone.
- Reduced motion disables timeline reveal animations.

## Acceptance criteria

- A promoted session opens as a structured timeline.
- User messages, agent messages, tool calls, tool results, and artifacts have
  distinct renderers.
- Large outputs are previewed safely and expandable only through authorized
  object/artifact reads.
- Unknown or partial events render without breaking the page.
- Desktop inspector and mobile drawer both work.
- The page remains responsive for long sessions.

