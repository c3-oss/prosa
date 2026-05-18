# Lane 7 — CLI and MCP

## Goal

Ship the new CLI command surface (`prosa read *` group plus `prosa tui` kept top-level), the MCP server with pinned-authority modes (`auto`/`local`/`remote`), and the web data layer rewrite. Both CLI and MCP consume Lane 6's read API. The CLI receipt refresh policy (60 s TTL, `--refresh` force, HTTP 412 mid-command) is implemented here.

## Depends on

- Lane 6 (Read API) complete — consumers need the `/v2/reads/*` endpoints + authority refresh.

## Deliverables

- New CLI command group under `apps/cli/src/cli/v2/commands/read/` with subcommands: `sessions`, `transcript`, `search`, `tool-calls`, `analytics`, `export`, `tui`. Plus `prosa tui` kept as a top-level alias.
- `apps/cli/src/cli/v2/authority/` implementing the 60 s TTL cache, refresh policy, 412 handling.
- `apps/cli/src/cli/v2/mcp/` with `prosa mcp serve --authority {auto|local|remote} [--refresh]`.
- `apps/web` data layer rewritten to point at `/v2/reads/*`. Routes preserved.
- 1:1 mapping documented for v1 → v2 command surface (see L17).

## Tasks

1. **`prosa read sessions [filters]`** lists sessions. Calls `/v2/reads/sessions/list`. Flags: `--source`, `--project`, `--since`, `--until`, `--limit`, `--cursor`, `--output-format`, `--columns`.
2. **`prosa read sessions --count [filters]`** scalar count. Calls `/v2/reads/sessions/count`.
3. **`prosa read transcript <session-id>`** paginated transcript. Calls `/v2/reads/sessions/transcript`. Flags: `--format {text|markdown|json}`, `--cursor`, `--all-pages` (fetches sequential pages and concatenates — for export tooling).
4. **`prosa read search <query>`** full-text search. Flags: `--role`, `--tool-name`, `--canonical-type`, `--errors-only`, `--limit`, `--cursor`.
5. **`prosa read tool-calls`** audit. Calls `/v2/reads/tool-calls/list`.
6. **`prosa read analytics <report>`** fixed reports. `<report>` ∈ `sessions|tools|errors|models|projects`. Flags: `--source`, `--since`, `--until`, `--project`, `--limit`, `--output-format`, `--columns`.
7. **`prosa read query '<sql>' [--engine duckdb]`** ad-hoc analytics. **Local-only** (DuckDB over Parquet). Fails with explicit message if invoked against a promoted store without `--local`.
8. **`prosa read export parquet [--out <dir>]`** Parquet export. Local-only.
9. **`prosa tui`** kept as top-level command (not `prosa read tui`). Flags: `--authority {auto|local|remote}`, `--refresh`, `--offline`.
10. **CLI authority cache.** `apps/cli/src/cli/v2/authority/cache.ts` persists `CachedAuthorityV2` in `~/.config/prosa/authority/<storeId>.json`. Refresh rules from L12: within TTL skip HTTP; outside TTL or `--refresh`, GET `/v2/stores/:storeId/authority`. On 412 mid-command, refresh once then retry idempotent reads; for streaming output, stop with explicit "authority changed" message.
11. **MCP server `prosa mcp serve --authority {auto|local|remote}`.** Pins `ReadContext` at server startup (refresh once if `auto`/`remote`; else from local config). Refresh only via explicit `prosa.refresh_authority` MCP tool, server 412, or process restart. Tools: `search`, `sessions`, `tool_calls`, `analytics`, `artifact`, `compile`, plus new `prosa.refresh_authority`.
12. **Web data layer rewrite.** `apps/web/src/lib/api-v2.ts` exposes typed clients. Routes call `api.v2.reads.sessions.list.query(...)`. tRPC client replaced by typed fetch (or kept on tRPC if `/v2` is exposed via tRPC at server side — implementation detail). All queries gated on `tenantId` from `useAuth()` as today.

## Concrete types and schemas

### v1 → v2 command mapping (the L17 contract)

| v1 command | v2 command |
|---|---|
| `prosa sessions list` | `prosa read sessions [filters]` |
| `prosa sessions count` | `prosa read sessions --count [filters]` |
| `prosa session show <id> --format markdown` | `prosa read transcript <id> --format markdown` |
| `prosa session show <id> --json` | `prosa read transcript <id> --json` |
| `prosa search <query>` | `prosa read search <query>` |
| `prosa query duckdb '<sql>'` | `prosa read query '<sql>' --engine duckdb` |
| `prosa analytics {sessions\|tools\|errors\|models\|projects}` | `prosa read analytics <report>` |
| `prosa export session <id>` | `prosa read transcript <id> --format markdown --output <path>` |
| `prosa export parquet` | `prosa read export parquet` |
| `prosa mcp serve` | `prosa mcp serve --authority {auto\|local\|remote}` |
| `prosa tui` | `prosa tui` (unchanged; backed by `ReadContext`) |

v1 commands stay registered (alongside v2) until Lane 10 cutover, where they print a deprecation notice on invocation and then are removed.

### CLI authority cache

```ts
// apps/cli/src/cli/v2/authority/types.ts
export type CachedAuthorityV2 = {
  tenantId: string
  storeId: string
  receiptId: string
  bundleRoot: string
  serverUrl: string
  checkedAt: string         // ISO timestamp of last refresh
  expiresAt: string         // checkedAt + TTL
  auditStatus: 'ok' | 'degraded' | 'invalidated'
  repair?: RepairRequest
}

// apps/cli/src/cli/v2/authority/cache.ts
const TTL_MS_INTERACTIVE = 60_000

export async function getCachedAuthority(
  configDir: string,
  storeId: string,
): Promise<CachedAuthorityV2 | null> {
  const file = path.join(configDir, 'authority', `${storeId}.json`)
  return readJsonIfExists<CachedAuthorityV2>(file)
}

export async function resolveAuthority(
  configDir: string,
  storeId: string,
  options: { forceRefresh: boolean; offline: boolean },
): Promise<CachedAuthorityV2> {
  const cached = await getCachedAuthority(configDir, storeId)

  if (options.offline) {
    if (!cached) throw new Error('--offline but no cached authority; run without --offline first')
    return cached
  }

  const now = Date.now()
  if (cached && !options.forceRefresh) {
    const expiresAt = Date.parse(cached.expiresAt)
    if (expiresAt > now) {
      return cached    // skip HTTP call
    }
  }

  const response = await fetchAuthorityRefresh(cached?.serverUrl ?? defaultServerUrl(), storeId, cached?.receiptId)
  // ... persist + return
}
```

### MCP authority modes

```ts
// apps/cli/src/cli/v2/mcp/serve.ts
export async function serveMcp(options: McpServeOptions): Promise<void> {
  const authority = options.authority ?? 'auto'
  const refreshed = options.refresh
    ? await refreshAuthorityNow(options.configDir, options.storeId)
    : await resolveAuthority(options.configDir, options.storeId, { forceRefresh: false, offline: authority === 'local' })

  // Pin at server startup.
  const readContext: PinnedReadContext = {
    tenantId: refreshed.tenantId,
    storeId: refreshed.storeId,
    receiptId: refreshed.receiptId,
    bundleRoot: refreshed.bundleRoot,
    authority,
    serverUrl: refreshed.serverUrl,
  }

  const server = createMcpServer({
    bundle: openBundleV2(options.bundlePath),
    readContext,
    onAuthorityChanged: () => {
      // Server 412 mid-call → return AUTHORITY_CHANGED to caller; do NOT auto-refresh.
    },
  })

  // Register tools, including:
  server.registerTool('prosa.refresh_authority', {
    title: 'Refresh the pinned authority',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async () => {
    const newAuthority = await refreshAuthorityNow(options.configDir, options.storeId)
    Object.assign(readContext, {
      receiptId: newAuthority.receiptId,
      bundleRoot: newAuthority.bundleRoot,
    })
    return { content: [{ type: 'text', text: JSON.stringify({ receiptId: newAuthority.receiptId }) }] }
  })

  // ... search, sessions, tool_calls, analytics, artifact, compile
  await connectTransport(server, options.transport)
}
```

The "auto" mode resolves to local if a local bundle exists at `storePath` AND its `bundleRoot` matches the cached receipt's `bundleRoot`. Otherwise resolves to remote. Decision made **once** at server startup. Subsequent tool calls within the MCP process never re-evaluate.

### Web data layer

```ts
// apps/web/src/lib/api-v2.ts
import { z } from 'zod'

const baseUrl = import.meta.env.VITE_PROSA_API_URL

async function v2Fetch<T>(path: string, body: unknown): Promise<T> {
  const tenantId = useAuthStore.getState().tenantId
  if (!tenantId) throw new Error('No tenant')
  const res = await fetch(`${baseUrl}/v2/reads${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-prosa-tenant-id': tenantId,
      authorization: `Bearer ${useAuthStore.getState().token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await mapHttpError(res)
  return res.json() as Promise<T>
}

export const api = {
  v2: {
    sessions: {
      list: (input: ListSessionsInput) => v2Fetch<ListSessionsResponse>('/sessions/list', input),
      count: (input: CountSessionsInput) => v2Fetch<{ count: number }>('/sessions/count', input),
      transcript: (input: TranscriptPageInput) => v2Fetch<TranscriptPageResponse>('/sessions/transcript', input),
    },
    search: {
      query: (input: SearchQueryInput) => v2Fetch<SearchQueryResponse>('/search/query', input),
    },
    // ... toolCalls, artifacts, analytics
  },
}
```

React Query queries swap from `api.sessions.list.query(...)` to `api.v2.sessions.list(...)`. Routes update import paths but route shape stays identical.

## Tests

| File | Asserts |
|---|---|
| `apps/cli/test/v2/read-sessions.test.ts` | `prosa read sessions` against E2E harness returns expected rows; `--output-format json` produces valid JSON. |
| `apps/cli/test/v2/read-transcript.test.ts` | `prosa read transcript <id> --all-pages` fetches all pages sequentially; concatenated output matches single-page format. |
| `apps/cli/test/v2/authority-refresh.test.ts` | TTL behavior: within 60 s skips network; outside refreshes; `--refresh` forces; 412 mid-command stops with explicit message. |
| `apps/cli/test/v2/authority-offline.test.ts` | `--offline` uses cached authority; fails if no cache. |
| `apps/cli/test/v2/mcp-pinned.test.ts` | MCP server with `--authority auto` resolves once at startup; `prosa.refresh_authority` updates the pinned context. |
| `apps/cli/test/v2/mcp-authority-change.test.ts` | Server returns 412 mid-tool-call → MCP returns `AUTHORITY_CHANGED` error to caller, doesn't auto-refresh. |
| `apps/web/e2e/sessions-page.test.ts` | Playwright: `/console/sessions` loads, paginates, filters by source/project. |
| `apps/web/e2e/search-page.test.ts` | Playwright: search returns hits with snippets; filters operate. |
| `apps/web/e2e/transcript-page.test.ts` | Playwright: transcript paginates; large bodies fetched lazily via `artifacts.getText`. |

## Gate

The lane is complete when:

1. All test files above pass.
2. Manual smoke against the E2E harness: every `prosa read *` command works as documented; outputs match v1 equivalents for the same data.
3. MCP authority modes verified: `--authority auto` chooses local when bundle root matches, remote otherwise; `--authority local` fails closed when bundle is purged; `--authority remote` always remote.
4. Web console end-to-end: all routes (`/console/dashboard`, `/console/sessions`, `/console/session/:id`, `/console/search`, `/console/tool-calls`, `/console/analytics`) render correctly against `/v2/reads/*`.
5. CLI authority refresh metrics: at most one `GET /authority` per 60 s per (tenant, store) under load test.

## Risks

| Risk | Mitigation |
|---|---|
| Scripts depending on v1 command names break on cutover | v1 commands stay registered until Lane 10; deprecation notice printed on each invocation in the cutover release. Document mapping in CHANGELOG. |
| MCP "auto" mode resolves wrong on edge cases | Test fixture: bundle present but bundle_root mismatch with receipt → "auto" resolves to remote. |
| `--all-pages` for transcript exceeds memory on huge sessions | Document streaming alternative; `--all-pages` is for export tooling and accepts the memory cost. |
| Web tRPC removal breaks browser caching behavior | Keep React Query layer; only the fetch transport changes. |

## Unblocks

Lane 8 (`09-lane-8-audit-and-gc.md`) — audit and GC cron roles need the API workers running, but this lane's deliverable doesn't depend on them; sequencing is for testability under realistic traffic.
