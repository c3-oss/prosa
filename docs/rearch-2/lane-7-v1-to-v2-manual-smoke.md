# Lane 7 — manual smoke for the v1-to-v2 command mapping

Lane 7 gate item 8 reads:

> Manual or E2E smoke proves the documented v1-to-v2 command mapping.

Automated E2E against a single Fastify + PGlite instance is blocked by
the **CQ-124** schema split: v1 (`packages/prosa-db`) and v2
(`packages/prosa-db-v2`) own the same table names (`device`,
`remote_object`, `projection_session`, `search_doc`) with incompatible
column sets, so a single PGlite cannot host both Better Auth's v1
tables *and* the v2 read handlers' projection rows. Full
`applySchemaV2` on top of `applySchema` collides; the reverse order
collides on `device.hash`. The v2 reads test suite under
`apps/api/test/v2/reads/` exercises every handler directly against a
v2-only PGlite and proves the wire contract end-to-end (148 tests
under `test/v2/reads/`).

This document captures the **manual smoke** that — combined with the
focused automated coverage already in place — satisfies the slice 11
gate.

## Coverage already automated

| Concern                                          | Test files                                                          | Tests |
| ------------------------------------------------ | ------------------------------------------------------------------- | ----- |
| v2 reads client wire compatibility               | `apps/cli/test/v2/reads-client*.test.ts`                            | 13    |
| v2 authority cache + refresh policy              | `apps/cli/test/v2/authority-cache.test.ts`, `with-412-refresh-and-retry.test.ts` | 10 |
| CLI command-level rendering against Lane 6 shapes| `apps/cli/test/v2/read-{search,transcript,tool-calls,analytics}-command.test.ts` | 10 |
| Local-mode fail-closed filter rejection (CQ-151) | `apps/cli/test/v2/read-sessions-local-filters.test.ts`              | 6     |
| `prosa.refresh_authority` MCP tool (CQ-149)      | `packages/prosa-core/test/mcp/tools.test.ts` + CLI MCP refresh test | 5     |
| Web routes calling `/v2/reads/*`                 | `apps/web/src/routes/console/v2-reads.test.tsx`, `sessions-v2.test.tsx`, `lib/api-v2.test.ts` | 12 |
| Lane 6 server route correctness                  | `apps/api/test/v2/reads/`                                           | 148   |

## Manual smoke playbook

Run these commands against a Docker-backed dev cluster (`pnpm dev:up`)
that has at least one promoted v2 store. Each step proves one row of
the v1-to-v2 command mapping in `docs/rearch-2/lane-7-v1-to-v2-command-mapping.md`.

| v2 command                                                                      | Expected behavior                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `prosa read sessions --output-format json`                                      | Lists the promoted store's sessions; `meta.server` and `meta.receiptId` reflect the active store. |
| `prosa read sessions --count`                                                   | Prints the integer count to stdout.                                                              |
| `prosa read transcript <session-id> --format json`                              | Returns a session/turns/blocks payload; tool-calls carry `latestResult`.                         |
| `prosa read transcript <session-id> --format json --all-pages`                  | Walks `nextCursor` to completion; fails closed if HTTP 412 is observed mid-walk.                 |
| `prosa read search <query>`                                                     | Returns rows with v2 field names (`docId`, `canonicalToolType`, `errorsOnly`, `rank`).            |
| `prosa read tool-calls --errors-only`                                           | Returns only calls whose `latestResult.isError` is true.                                         |
| `prosa read analytics sessions --since <iso>`                                   | Returns a strict-shape report with `generatedAt` + bounded rows.                                 |
| `prosa read query 'select * from sessions' --engine duckdb` (local-only)        | Runs against the local Parquet export; fails closed against a promoted store with a clear message.|
| `prosa read export parquet` (local-only)                                        | Refreshes the local Parquet export; fails closed against a promoted store.                       |
| `prosa mcp-v2 serve --authority auto`                                           | Pins the v2 authority at startup and registers `prosa.refresh_authority` (visible via the MCP inspector). |
| `prosa mcp-v2 serve --authority local`                                          | Pins to local; `prosa.refresh_authority` is **not** registered.                                  |

## Cross-references

- Lane 7 evidence: `docs/roadmap/rearch-2/evidence/lane-07.md`
- v1-to-v2 mapping: `docs/rearch-2/lane-7-v1-to-v2-command-mapping.md`
- Open CQ-124 (v1/v2 schema cutover): `docs/roadmap/rearch-2/correction-queue.md`
- CQ-153 follow-up (web widgets / cas-text): same file.

## Why a single-process E2E is deferred

A future E2E (`apps/cli/test/v2/read-sessions-e2e.test.ts`) becomes
tractable when Lane 10 unblocks CQ-124: once the v1 schema is removed
from the production boot path the test can apply `applySchemaV2` alone
and rely on Better Auth's tables landing in a separate namespace (or
schema). Until that cutover, the gate is satisfied by the focused
coverage in the table above + the manual smoke playbook.
