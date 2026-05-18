# Lane Evidence

Lane: 06 - Read API
Status: blocked-on-lane-05
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] Authority refresh endpoint returns updated, unchanged, or
  gone_or_forbidden with 30 s cache semantics.
- [ ] Sessions list/count/detail/transcript, search, tool calls, artifacts, and
  analytics endpoints are receipt-pinned.
- [ ] All projection reads join or filter through `remote_authority_v2`.
- [ ] Artifact text reads verify tenant, projection, receipt grant, and pack
  availability.
- [ ] Postgres FTS filters and pagination cursors are stable.
- [ ] Cross-store distinct session conflict resolution is tested.

## Implementation Notes

- Source contract: `docs/rearch-2/07-lane-6-read-api.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must show fail-closed behavior for stale receipts, missing authority,
  missing grants, and cross-tenant access attempts.

## Known Risks

- A missed verified-projection gate can expose unsealed or wrong-tenant data.

## Reviewer Notes

- Pending `ralph-loop-remote-read-reviewer`,
  `ralph-loop-security-reviewer`, and `prosa-cli-search-specialist` review.
