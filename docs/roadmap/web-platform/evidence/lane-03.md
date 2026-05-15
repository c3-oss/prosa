# Lane Evidence

Lane: 03 Browser auth and tenancy
Status: open
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] AC-001 New user can sign up, create a tenant, and reach `/console`.
- [ ] AC-002 Existing user can log in and reach the active tenant console.
- [ ] AC-003 Logout clears cached protected data.
- [ ] AC-004 Tenant switch invalidates and reloads tenant-scoped queries.
- [ ] AC-005 Non-members cannot access tenant data by manually setting a tenant
  ID.
- [ ] AC-006 Normal members cannot invite users.
- [ ] AC-007 Admin invite flow is visible and protected.
- [ ] AC-008 CORS and Better Auth trusted origins support credentialed browser
  auth from configured web origins.

## Implementation Notes

- Extend existing `apps/api` Better Auth and tenant surfaces.
- Keep browser cookie auth separate from CLI bearer/device auth.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- No session tokens in localStorage.
- No logging of passwords, auth headers, cookies, invite links, or tokens.
- Server-side membership checks remain authoritative.

## Known Risks

- Browser auth can appear to work while CORS/cookie production settings remain
  unsafe; lane 08 must harden production behavior.

## Reviewer Notes

- Codex review pending.
