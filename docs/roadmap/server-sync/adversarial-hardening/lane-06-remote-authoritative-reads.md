# Lane 06: Remote-Authoritative Read Surface

Severity: high

## Problem

The product requirement is explicit: after login + sync, the remote server is
authoritative. The CLI should answer search, reports, views, exports, and other
read operations from the server, as if processing had happened locally.

Current implementation is partial:

- `search` has a remote branch.
- `sessions list` has a remote branch.
- `sessions count` still reads local bundle.
- `analytics` still reads local Parquet/bundle.
- `query` still reads local Parquet.
- `export` still exports from local bundle.
- `mcp` still opens local bundle.
- `tui` still uses local store behavior.
- `doctor`, `index`, and `compile` need explicit semantics in remote mode.

This is both a product bug and a security/data integrity risk. If local data
was purged after sync, local reads fail. If local data was kept, local reads can
return stale data and contradict the server.

## Attack / Failure Scenarios

### Scenario 1: Stale Local Data Wins

1. Device A syncs to server.
2. Device B syncs or updates server later.
3. Device A kept local bundle.
4. `analytics` still reads local Parquet.

Impact: user sees stale or incomplete reports while believing remote is
authoritative.

### Scenario 2: Purged Local Data Breaks Commands

1. User syncs with `--purge-bundle`.
2. `sessions list` works remotely.
3. `export` or `analytics` opens local bundle and fails.

Impact: remote-authoritative contract is broken.

### Scenario 3: Inconsistent Search Semantics

Remote `search.query` uses `ILIKE` over `search_doc.body`, while local search
uses FTS5 or Tantivy.

Impact: remote results are not equivalent to local processing. User can miss or
gain results unexpectedly.

## Required Changes

### 1. Define Command Semantics Matrix

Create a matrix for every command:

```text
command | before auth | after auth before sync | after sync | remote support | fallback
```

Each command must choose one:

- remote implementation;
- fail-closed with clear message;
- explicitly local-only and documented.

No command should silently read local state after a store is promoted unless it
has an explicit `--local` or similar override.

### 2. Add Remote Routes For Missing Surfaces

At minimum:

- `sessions.count`
- `analytics.summary` plus report-specific routes matching local reports
- `query` equivalent for remote tabular/SQL-like queries, or explicitly delay
  query with fail-closed
- `export.sessionMarkdown`
- `export.parquetSnapshot` or server-generated export artifact
- MCP tool routes

### 3. Make Remote Search Semantics Explicit

Do not pretend `ILIKE` is equivalent to FTS5/Tantivy.

Options:

- implement PostgreSQL full text search with ranking/snippets;
- use server-side Tantivy/indexing;
- document remote search as a different engine and expose `engine=remote-pg`;
- fail if user requests unsupported local-only engine after promotion.

### 4. Add Authority Enforcement Helper

Read commands should share a helper:

```ts
resolveReadAuthorityOrFailClosed(commandName, options)
```

Rules:

- if promoted and remote route exists: use remote;
- if promoted and remote route missing: fail with actionable message;
- if `--local` is provided: use local and show explicit local/stale marker;
- if not promoted: use local.

### 5. Extend Server Projection

Remote parity cannot exist until the server stores enough projection data.
Current sync uploads sessions and search docs, but not full turns/messages/tool
calls/tool results/artifacts/edges.

This lane should either:

- add those projection entities; or
- mark dependent commands fail-closed until a later projection lane.

## Acceptance Criteria

- Every CLI read command has an explicit promoted-store behavior.
- No promoted-store command silently opens local bundle by default.
- `sessions count` works remotely or fails closed.
- `analytics` works remotely for at least supported reports or fails closed.
- `query`, `export`, `mcp`, and `tui` are remote-aware.
- Search documentation and output identify the remote search engine semantics.
- Tests cover promoted store with local bundle missing.

## Required Tests

- `apps/cli/test/cli/remote-authority.test.ts`
  - promoted store + missing local bundle:
    - `search` succeeds remotely;
    - `sessions` succeeds remotely;
    - `sessions count` succeeds remotely or fails closed;
    - `analytics` succeeds remotely or fails closed;
    - `query` fails closed if unsupported;
    - `export` fails closed if unsupported;
    - `mcp` fails closed or uses remote.

- `apps/api/test/reads.test.ts`
  - remote route tenant isolation;
  - count/report correctness;
  - search limit and query behavior.

## Files Likely Touched

- `apps/cli/src/cli/auth/routing.ts`
- `apps/cli/src/cli/commands/*.ts`
- `apps/api/src/trpc/routers/reads.ts`
- `apps/api/src/trpc/router.ts`
- `packages/prosa-sync/src/index.ts`
- `apps/api/test/*`
- `apps/cli/test/*`

## Non-Goals

- Do not solve transactionality here.
- Do not solve chunked upload here unless new projection entities require it.

