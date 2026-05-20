# rearch-2 Correction Queue

Updated: 2026-05-20 after Codex/governor acceptance of Lane 6.

## Active Corrections For Lanes 7-9

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
