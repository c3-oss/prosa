# rearch-2 Correction Queue

Updated: 2026-05-20 after Codex/governor acceptance of Lane 6.

## Active Corrections For Lanes 7-9

### CQ-150: CLI and web v2 read clients are not wire-compatible with Lane 6 schemas

Severity: critical

Blocking: yes for Lane 7.

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/read/search.ts`
- `apps/cli/src/cli/v2/commands/read/transcript.ts`
- `apps/cli/src/cli/v2/commands/read/tool-calls.ts`
- `apps/cli/src/cli/v2/commands/read/analytics.ts`
- `apps/web/src/lib/api-v2.ts`
- `apps/api/src/v2/reads/**`

Risk: focused helper tests pass while real commands can send unsupported
filters, silently drop intended filters, or render empty/misnamed fields from
real Lane 6 responses. Examples found by Codex reviewer:

- search CLI sends `role`, `toolName`, `canonicalType`, and `projectIds`, while
  `/v2/reads/search/query` accepts `roles`, `toolNames`,
  `canonicalToolTypes`, `entityTypes`, `sessionId`, `since`, and `until`.
- transcript rendering expects `block.text`, `turn.startedAt`, and
  `call.result`, while the route returns `textInline`, `timestampStart`,
  `latestResult`, and a nullable not-found response shape.
- tool-calls rendering expects `startedAt`, `resultStatus`, and `summary`,
  while the route returns `timestampStart` and `latestResult`.
- analytics sends `projectIds`, while the strict server schema does not accept
  project filters.

Required fix:
- Align every CLI and web v2 request/response type with the actual Lane 6 route
  schemas.
- Remove unsupported flags or fail closed with explicit messages when a
  documented filter has no server support.
- Update output rendering to use the actual response fields.

Acceptance:
- [ ] Focused command-level tests cover `read search`, `read transcript`,
  `read tool-calls`, and `read analytics` against representative Lane 6 payloads.
- [ ] Tests prove unsupported filters are either translated correctly or rejected
  explicitly, never silently ignored.
- [ ] `pnpm --filter @c3-oss/prosa exec vitest run test/v2/` passes.
- [ ] Relevant web v2 client tests pass after schema alignment.

### CQ-151: Local read fallbacks ignore documented filters

Severity: high

Blocking: yes for Lane 7.

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/read/search.ts`
- `apps/cli/src/cli/v2/commands/read/sessions.ts`

Risk: in `auto`, unpromoted stores route local; documented filters like
`--project`, `--cursor`, and search filter flags can be ignored, returning
broader output than the operator requested.

Required fix:
- Make local fallbacks honor the same documented filters where local services
  support them.
- For unsupported local filters, fail closed with a clear message instead of
  returning broader results.

Acceptance:
- [ ] Focused tests prove local `read sessions` does not silently ignore
  project/cursor filters.
- [ ] Focused tests prove local `read search` honors supported filters or
  rejects unsupported filters explicitly.

### CQ-152: CLI HTTP 412 handling does not refresh once and retry idempotent reads

Severity: high

Blocking: yes for Lane 7.

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/read/common.ts`
- `apps/cli/src/cli/v2/authority/resolve.ts`
- `apps/cli/src/cli/v2/commands/read/*.ts`

Risk: Lane 7 requires one authority refresh plus retry for idempotent reads.
Current `with412Retry` converts `AuthorityChangedHttpError` to a CLI error but
does not refresh authority or retry, so normal single-page reads fail when the
server reports a newer authority.

Required fix:
- Implement one refresh plus retry for idempotent single-page read commands.
- Keep streaming or multi-page outputs such as `transcript --all-pages`
  fail-closed with an explicit rerun message when authority changes mid-stream.

Acceptance:
- [ ] Focused tests prove a single-page read refreshes authority once and
  retries after HTTP 412.
- [ ] Focused tests prove repeated 412 stops explicitly without looping.
- [ ] Focused tests prove multi-page/streaming output stops with a clear
  authority-changed error.

### CQ-153: Web console routes still use legacy tRPC and v2 client is not fail-closed

Severity: critical

Blocking: yes for Lane 7.

Affected lane: Lane 7.

Affected paths:
- `apps/web/src/app/providers.tsx`
- `apps/web/src/lib/api-v2.ts`
- `apps/web/src/routes/console/**`
- `apps/web/src/components/console/dashboard/widgets/**`
- `apps/web/src/components/console/transcript/cas-text.tsx`
- `apps/api/src/v2/reads/artifacts/get-text.ts`

Risk: `apps/web/src/lib/api-v2.ts` exists, but the app provider and console
routes still use the legacy tRPC client for promoted read data. The v2 helper
also omits `x-prosa-tenant-id` when no tenant is active, allowing the server to
fall back to session active organization instead of failing closed. Route shape
preservation is not yet proven for sessions, transcript, search, tool-calls,
analytics, dashboard widgets, or artifact/CAS text.

Required fix:
- Wire the console read routes to a v2 read client while preserving existing
  route/component shapes.
- Translate legacy UI filters to exact v2 route inputs.
- Require an active tenant before every v2 read fetch.
- Add v2 coverage or explicit fail-closed behavior for dashboard widgets and
  transcript large-body/artifact text reads.

Acceptance:
- [ ] Route-level tests prove console read routes call `/v2/reads/*`, not
  legacy `/trpc` read procedures, for sessions, session detail, search,
  tool-calls, analytics, dashboard, and artifact/CAS text where supported.
- [ ] Missing-tenant v2 client test proves no network request is made.
- [ ] Filter translation tests prove source/project/time/search filters are
  preserved or rejected explicitly.
- [ ] Transcript large-body rendering either works through a v2 read endpoint or
  renders an explicit unavailable state without legacy fallback.

### CQ-149: `prosa.refresh_authority` MCP tool not yet registered

Severity: medium

Blocking: yes for Lane 7 gate item 11 (MCP tool registration).

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/mcp-serve.ts` — pins authority at
  startup, logs it to stderr, but does not register a
  `prosa.refresh_authority` tool inside the running McpServer.
- `packages/prosa-core/src/mcp/tools.ts` — would need an
  `onRefreshAuthority` callback / extra tool registration hook.

Risk: MCP clients cannot trigger an authority refresh inside the
session; today the operator must restart the server. Acceptable for
the slice 9 minimum (which surfaces the pinned context for Lane 8
audit-drift signalling) but lane 7 gate is not green until the
tool exists.

Required fix:
- Extend `prosa-core` MCP tool factory to accept an
  `onRefreshAuthority` callback and register the
  `prosa.refresh_authority` tool when provided.
- Wire `prosa mcp serve --authority` to pass a closure that calls
  `refreshAuthorityNow` and mutates the pinned `ReadContext`.

Acceptance:
- [ ] Focused test verifying the tool is registered when authority
  is `auto` or `remote`.
- [ ] Focused test verifying the tool is absent in `--authority local`.
- [ ] Focused test verifying a 412 mid-tool-call surfaces
  `AUTHORITY_CHANGED` to the caller (does not auto-refresh).



When Ralph or Codex finds a blocker, add it here with:

- stable `CQ-*` id;
- severity and blocking flag;
- affected lane and paths;
- concrete risk;
- required fix;
- acceptance criteria;
- command evidence.

Do not close a CQ from claims alone. Close it only when code, tests, and
evidence satisfy the written acceptance criteria.

## Deferred Future Corrections

### CQ-124: v1 and v2 schemas share table names with incompatible columns

Severity: critical

Blocking: yes for Lane 10 cutover; not blocking Lanes 7-9 unless fresh
smoke-command evidence proves a direct dependency.

Status: open — deferred to Lane 10.

Risk: full `applySchemaV2` over v1 and projection/search materialization still
need the final v1/v2 cutover strategy. Lane 5 and Lane 6 were accepted with the
documented subset workaround and verified read gates.

Acceptance for future Lane 10:

- [ ] Lane 10 cutover plan documents the v1-to-v2 table migration or namespace
  strategy.
- [ ] Production boot applies the final schema over a v1-shaped database.
- [ ] Projection and search materialization use the final v2 schema without
  shared-name table conflicts.
- [ ] Focused tests prove the cutover path and rollback behavior.

### CQ-134: SealPromotion emits authority receipts before full projection/search materialization

Severity: critical

Blocking: yes for Lane 10 cutover; not blocking Lanes 7-9 unless fresh
smoke-command evidence proves a direct dependency.

Status: partially closed — object coverage and pack-byte presence are accepted;
remaining projection/search materialization is deferred behind CQ-124 to Lane
10.

Risk: Lane 5 seal acceptance proved object coverage and pack-byte presence, and
Lane 6 reads fail closed to rows already proven by current authority. Full
seal-time projection/search materialization remains tied to the final schema
cutover.

Acceptance for future Lane 10:

- [ ] Seal path proves projection rows before authority swap.
- [ ] Seal path proves search docs before authority swap.
- [ ] Any materialization failure leaves authority unchanged and returns a
  clear failure.
- [ ] Tests pin object coverage, projection coverage, search coverage, and
  fail-closed rollback.

## Closed Summary

Lanes 0-6 are accepted. Historical CQ detail was compacted after Lane 6
acceptance; use git history before this commit for the full per-slice audit
trail.

Notable closed Lane 6 corrections:

- CQ-142: cursor snapshot/integrity and HTTP `INVALID_CURSOR` coverage.
- CQ-143: CLI fail-closed local guidance before Lane 7 consumers.
- CQ-144: opaque artifact misses.
- CQ-145: artifact route miss/success matrix.
- CQ-146: production cursor secret/config wiring.
- CQ-147: analytics tuple-match and strict route input.
- CQ-148: `tool-calls/list` latest-result join tuple-matches
  `tool_call_id/session_id/store_id/receipt_id`.
- CQ-148 follow-up: `sessions/transcript` latest-result lookup also
  tuple-matches `tool_call_id/session_id/store_id/receipt_id`, preventing a
  current-authority result from another session/store/receipt from attaching to
  the visible transcript call.
