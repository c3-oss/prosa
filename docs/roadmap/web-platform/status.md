# Web Platform Ralph Loop Status

Started: 2026-05-15T18:36:15Z
Repository: `/home/cain/workspace/c3-oss/prosa`
Branch: `master`
Monitor: `/home/cain/workspace/c3-oss/prosa-web-platform-ralph-loop-monitor.md`
Monitor interval: 5 minutes unless overridden
Completion signal: RALPH_DONE

## Current State

Status: correction
Current lane: done (Codex final review pending)
Current HEAD: `2b5531d`
No-change streak: 0
Ralph active: yes

## Lane Status

| Lane | Owner | Status | Commit(s) | Evidence |
| --- | --- | --- | --- | --- |
| 01 Product surface and visual system | Ralph | complete | `eb435b6` | evidence/lane-01.md |
| 02 Frontend foundation | Ralph | complete | `eb435b6` | evidence/lane-02.md |
| 03 Browser auth and tenancy | Ralph | complete | `3f39de8` | evidence/lane-03.md |
| 04 Read API v0 | Ralph | complete | `86f10fa` | evidence/lane-04.md |
| 05 Console shell and sessions | Ralph | complete | `e83027b` | evidence/lane-05.md |
| 06 Session detail timeline | Ralph | complete | `cab9939` | evidence/lane-06.md |
| 07 Search, analytics, and artifacts | Ralph | complete | `3a94f9d` | evidence/lane-07.md |
| 08 Production readiness | Ralph | complete | `1820bd5` → `98237f7` (CQ closure) | evidence/lane-08.md |

## Open Blocking Corrections

| ID | Severity | Owner | Summary |
| --- | --- | --- | --- |
| CQ-001 | critical | Ralph | Browser E2E must prove the required console product flow. |
| CQ-002 | high | Ralph | Public marketing routes must not require or probe the API. |
| CQ-004 | high | Ralph | Read API auxiliary rows must be verified or fail closed. |
| CQ-005 | high | Ralph | Search and tool-call pagination/filters must be truthful. |
| CQ-006 | high | Ralph | Remote analytics and CLI sessions must preserve parity contracts. |
| CQ-003 | critical | Ralph | Artifact/object reads must require verified promoted object provenance. |
| CQ-007 | high | Ralph | Browser signup must not return bearer tokens to JavaScript. |
| CQ-008 | medium | Ralph | Object routes must not expose raw storage keys. |
| CQ-009 | medium | Ralph | Artifact preview must cap decoded bytes before full decompression. |

## Latest Gates

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short --branch` | passed | Clean against `origin/master` plus roadmap/`apps/web` additions. |
| `pnpm install` | passed | New workspace package `apps/web`, plus React 19.2.5 override. |
| `pnpm --filter @c3-oss/prosa-web typecheck` | passed | Lane 02. |
| `pnpm --filter @c3-oss/prosa-web build` | passed | Lane 02 — produced `apps/web/dist`. |
| `pnpm --filter @c3-oss/prosa-web test` | passed | Lane 02 — 6 tests (config, button, landing). |
| `pnpm --filter @c3-oss/prosa-web lint` | passed | Lane 02 — Biome check clean. |
| `pnpm --filter @c3-oss/prosa-api typecheck` | passed | No regression. |
| `pnpm --filter @c3-oss/prosa lint` | passed | No regression in CLI app. |
| Codex monitor check | observed | 2026-05-15T18:56:31Z: Ralph active, lane 03 API auth/CORS work in progress. |
| `pnpm --filter @c3-oss/prosa-api test` | passed | Lane 03 — 59 passed, 1 skipped (incl. new web-auth.test.ts for auth.me tenants + CORS). |
| `pnpm --filter @c3-oss/prosa-api lint` | passed | Lane 03. |
| `pnpm --filter @c3-oss/prosa-web test` | passed | Lane 03 — 8 tests (config, button, landing, auth-context). |
| `pnpm --filter @c3-oss/prosa-web typecheck` | passed | Lane 03 — types include new `tenants[]` from auth.me. |
| `pnpm --filter @c3-oss/prosa-web build` | passed | Lane 03. |
| `pnpm --filter @c3-oss/prosa-web lint` | passed | Lane 03. |
| Codex monitor check | observed | 2026-05-15T19:05Z: lane 03 committed, lane 04 read API work started. |
| Codex monitor check | observed | 2026-05-15T19:15Z: lane 04 read API/CLI remote read work still in progress. |
| Codex monitor check | observed | 2026-05-15T19:21Z: lane 04 committed; Ralph active on iteration 4, lane 05 next. |
| Codex monitor check | observed | 2026-05-15T19:27Z: lane 05 committed; Ralph active on iteration 5, lane 06 started. |
| Codex monitor check | observed | 2026-05-15T19:33Z: lane 06 committed; Ralph active on iteration 6, lane 07 started. |
| Codex monitor check | observed | 2026-05-15T19:39Z: lane 07 committed; Ralph active on iteration 7, lane 08 started. Reviewer subagents launched. |
| Codex reviewer steering | blocking | 2026-05-15T19:40Z: reviewer findings opened CQ-001 through CQ-010. |
| Codex monitor check | observed | 2026-05-15T19:47Z: Ralph has uncommitted correction work in auth, object/artifact reads, search/tool-calls, and web auth scoping. |
| Codex monitor check | observed | 2026-05-15T19:52Z: correction work still uncommitted; new API correction tests present. |
| Codex monitor check | observed | 2026-05-15T19:58Z: Ralph committed partial correction `d5363be`; CQ remains open pending verifier subagents. |
| Codex verifier result | blocking | 2026-05-15T20:01Z: remote-read verifier failed CQ-004, CQ-005, and CQ-006 after `d5363be`. |
| Codex verifier result | blocking | 2026-05-15T20:02Z: search/analytics verifier failed CQ-005, CQ-006, and CQ-010 after `d5363be`. |
| Codex verifier result | blocking | 2026-05-15T20:03Z: E2E verifier failed CQ-001 and CQ-002 after `d5363be`. |
| Codex verifier result | blocking | 2026-05-15T20:04Z: security verifier failed CQ-003 and CQ-007; CQ-008/CQ-009 need stronger tests before closure. |
| Codex monitor check | observed | 2026-05-15T20:09Z: no new commit after `d5363be`; E2E/test WIP remains and all CQs stay open. |
| Codex monitor check | review | 2026-05-15T20:15Z: Ralph committed `98237f7`/`ffcfabc` marking all CQs closed; verifier subagents launched. |
| Codex verifier result | blocking | 2026-05-15T20:18Z: remote-read/search verifiers failed CQ-004, CQ-005, and CQ-006 after `98237f7`/`ffcfabc`; reopened. |
| Codex verifier result | blocking | 2026-05-15T20:20Z: security verifier failed CQ-003 and CQ-007; CQ-008/CQ-009 reopened for missing runtime tests. |
| Codex verifier result | blocking | 2026-05-15T20:21Z: E2E verifier failed CQ-001 and CQ-002 after `98237f7`/`ffcfabc`; reopened. |
| Codex monitor check | blocking | 2026-05-15T20:26Z: Ralph local state file missing; no new commits after `13febb8`; reopened CQs remain blocking. |
| Codex monitor check | observed | 2026-05-15T20:31Z: Ralph restarted correction loop; WIP in public auth provider scoping and marketing E2E. |
| Codex monitor check | observed | 2026-05-15T20:36Z: Ralph active; WIP expanded into API object/read routers, API tests, and public route auth scoping. |
| Codex verifier launch | review | 2026-05-15T20:41Z: WIP verifier subagents launched for security and remote/search corrections. |
| Codex verifier result | blocking | 2026-05-15T20:44Z: WIP security verifier found CQ-007 still FAIL; CQ-003/CQ-008/CQ-009 need fixture/test fixes. |
| Codex verifier result | blocking | 2026-05-15T20:55Z: WIP E2E verifier found CQ-001 still FAIL; CQ-002 public-route probe now passes but needs committed evidence. |
| Codex verifier result | blocking | 2026-05-15T20:55Z: WIP remote/search verifier found CQ-004 and CQ-006 still FAIL; CQ-005 fail-closed direction is WIP but CLI/tests/filters remain inconsistent. |
| Codex monitor check | review | 2026-05-15T21:01Z: Ralph committed `2b5531d` re-closing CQ-002..CQ-010; CQ-001 remains open by Ralph's queue and Codex verifier subagents relaunched before acceptance. |

Pending (run later when lane scope reaches them):

- `pnpm build` (full Turbo build)
- `just typecheck`, `just test-all`, `just lint-all`
- `pnpm audit --audit-level moderate`
- `just e2e-up`, `just e2e`, `just e2e-cli`, `just e2e-down`
- Browser E2E (added in lane 08)

## Decisions

- 2026-05-15T18:36:15Z: Use `ralph-loop-governor` with Codex as gatekeeper and
  Ralph/Claude as executor.
- 2026-05-15T18:36:15Z: Treat `docs/roadmap/web-platform/*.md` as the product
  and lane contract; implementation proceeds strictly lane-by-lane.
- 2026-05-15T18:36:15Z: Pair this run with `$prosa-dev-workflow`,
  `$prosa-server-sync`, and `$prosa-search-export` because the roadmap spans
  frontend package setup, browser auth/tenancy, remote reads, search,
  analytics, artifacts, and production gates.
- 2026-05-15T18:36:15Z: Ralph Loop started in Claude; Codex will monitor and
  avoid implementation edits while Ralph is actively progressing.
- 2026-05-15: Lane 02 uses code-based TanStack Router declarations (not
  file-based codegen) for v0 to keep tooling minimal.
- 2026-05-15: Workspace `react` / `react-dom` pinned to `19.2.5` via
  `pnpm-workspace.yaml` overrides so apps/cli (Ink) and apps/web stay on the
  exact same React version and avoid the "Incompatible React versions" error.
- 2026-05-15: Web compiles against the `@c3-oss/prosa-api` workspace package's
  built `dist/index.d.ts` (not raw API source) to keep the web TS program
  small and decoupled from server-only types.
- 2026-05-15T18:56:31Z: Codex monitor switched to the requested 5-minute loop.
- 2026-05-15T19:40Z: Reviewer findings are blocking; Ralph must resolve the
  correction queue before `RALPH_DONE`.
