# Lane Evidence

Lane: 07 - CLI and MCP
Status: blocked-on-lane-06
Owner: Ralph
Commit range:

## Acceptance Criteria

- [ ] `prosa read sessions`, `transcript`, `search`, `tool-calls`,
  `analytics`, `query`, and `export parquet` work as documented.
- [ ] CLI authority cache obeys TTL, `--refresh`, `--offline`, and 412
  semantics.
- [ ] MCP server pins authority at startup and supports explicit
  `prosa.refresh_authority`.
- [ ] `prosa tui` remains top-level and respects authority modes.
- [ ] Web routes use `/v2/reads/*` while preserving route shape.
- [ ] v1 to v2 command mapping is documented and tested.

## Implementation Notes

- Source contract: `docs/rearch-2/08-lane-7-cli-and-mcp.md`.

## Commands Run

```text
not-run
```

## Data / Security Evidence

- Evidence must prove local, remote, auto, refresh, offline, and stale authority
  paths fail or succeed predictably.

## Known Risks

- MCP auto authority and streaming CLI retries can silently mix data from the
  wrong authority if not pinned carefully.

## Reviewer Notes

- Pending `prosa-cli-search-specialist` and `ralph-loop-remote-read-reviewer`
  review.
