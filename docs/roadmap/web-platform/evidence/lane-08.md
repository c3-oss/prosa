# Lane Evidence

Lane: 08 Production readiness
Status: open
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] AC-001 Web app and API have documented deployment configuration.
- [ ] AC-002 Browser E2E covers signup, login, console, sessions, detail,
  search, analytics, and logout.
- [ ] AC-003 Security tests cover tenant isolation and object access.
- [ ] AC-004 Accessibility and performance gates are explicit enough to block
  release.
- [ ] AC-005 Production readiness is treated as a lane and reflected in gates.
- [ ] AC-006 Production startup fails without real API URL, database URL, auth
  secret, and object-store configuration.

## Implementation Notes

- Add the browser E2E command and record it in `gates.md`.
- Same-origin static serving by `apps/api` can be supported, but CDN/static host
  plus API origin is the recommended v0 deployment shape.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- CORS allows only configured web origins.
- Cookies use production-appropriate secure/same-site settings.
- Logs must not include secrets, auth headers, cookies, object bytes, or invite
  tokens.
- Markdown and JSON/tool output rendering must not execute user-controlled HTML.

## Known Risks

- Production deploy can look functional while cookies/CORS/object access are
  unsafe; this lane must block release on those checks.

## Reviewer Notes

- Codex review pending.
