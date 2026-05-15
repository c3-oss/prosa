# Lane Evidence

Lane: 06 Session detail timeline
Status: open
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] AC-001 A promoted session opens as a structured timeline.
- [ ] AC-002 User messages, agent messages, tool calls, tool results, and
  artifacts have distinct renderers.
- [ ] AC-003 Large outputs are previewed safely and expandable only through
  authorized object/artifact reads.
- [ ] AC-004 Unknown or partial events render without breaking the page.
- [ ] AC-005 Desktop inspector and mobile drawer both work.
- [ ] AC-006 The page remains responsive for long sessions.

## Implementation Notes

- Use `sessions.detail` as the primary data source.
- Do not parse Markdown export to build the timeline.
- Add virtualization only when actual long-session behavior justifies it.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Full large content must flow through authorized artifact/object preview APIs.
- Markdown rendering must be sanitized.
- JSON/tool output rendering must not execute HTML.

## Known Risks

- Rendering full JSON or full tool output inline can freeze the browser and leak
  sensitive content into the visible UI.

## Reviewer Notes

- Codex review pending.
