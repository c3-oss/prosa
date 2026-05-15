# Lane Evidence

Lane: 05 Console shell and sessions
Status: open
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] AC-001 Authenticated user can open `/console` and see tenant-scoped
  summary data.
- [ ] AC-002 User can open `/console/sessions` and browse paginated sessions.
- [ ] AC-003 Filters call the API instead of filtering only the current page.
- [ ] AC-004 Empty tenant clearly explains how to populate data with CLI sync.
- [ ] AC-005 Non-member tenant access shows a forbidden state.
- [ ] AC-006 Layout works on desktop and mobile without horizontal overflow.

## Implementation Notes

- Do not show fake demo data in the authenticated console.
- Unknown timestamps sort last and render as `unknown`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Dashboard and sessions data must come from authenticated tenant-scoped API
  calls.
- 401, 403, rate limit, and network/API unavailable states need distinct UI.

## Known Risks

- Cursor pagination can be undermined if the UI sorts incomplete pages
  client-side.

## Reviewer Notes

- Codex review pending.
