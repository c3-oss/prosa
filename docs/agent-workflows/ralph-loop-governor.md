# Ralph Loop governor

This document defines the repeatable workflow for using Claude Ralph Loop as a
long-running implementation engine while Codex acts as architect, reviewer,
correction writer, and final gatekeeper.

Use Ralph/Claude for long-running implementation throughput. Use Codex as the
architect, governor, reviewer, correction writer, and final gatekeeper. The
governor's core job is to review code with subagents and steer Ralph through
blocking corrections. If Codex is only watching commits land, the workflow is
not being followed.

## Start From Codex

In Codex, start with:

```text
$ralph-loop-governor quero uma feature abc que faça X, Y e Z
```

Codex should infer the lanes, prompt, status file, correction queue, gates,
evidence templates, reviewer subagents, and Claude command from that single
request. The long form is only for unusual cases where you want to override the
defaults.

Long form, when needed:

```text
$ralph-loop-governor prepare um Ralph Loop para <feature>, usando <docs>, com monitoramento de 10 minutos e gate Docker E2E
```

For server-sync follow-up work, use:

```text
$ralph-loop-governor continuar server-sync usando docs/architecture/server-sync.md, ROADMAP.md e $prosa-server-sync como contexto
```

For server-sync work, read `.codex/skills/prosa-server-sync/SKILL.md` and
`docs/architecture/server-sync.md` as the canonical domain inputs. Use old
roadmap or retrospective files only via git history when explicitly
investigating prior Ralph runs.

When the feature touches server sync, Codex pairs `$ralph-loop-governor` with
`$prosa-server-sync`. The governor owns process artifacts and gates; the
server-sync skill owns the domain invariants for auth, tenancy, object storage,
promotion receipts, remote-authoritative reads, and Docker E2E.

## Run In Claude

Initial kickoff:

```text
/ralph-loop:ralph-loop "@docs/roadmap/<feature>/ralph-loop-prompt.md" --max-iterations 30 --completion-promise RALPH_DONE
```

Correction restart:

```text
/ralph-loop:ralph-loop "Read @docs/roadmap/<feature>/ralph-loop-prompt.md, @docs/roadmap/<feature>/correction-queue.md, and @docs/roadmap/<feature>/gates.md. Close every blocking correction with code, tests, and evidence. If no blocking correction remains, run five clean stabilization cycles: sleep 180 seconds, then reread correction queue, gates, status, git status, and recent commits. Any open blocker, failed gate, stale evidence, new commit, or unexplained dirty worktree resets the count to zero. Output RALPH_DONE only after five consecutive clean cycles." --max-iterations 20 --completion-promise RALPH_DONE
```

Keep natural-language prompts quoted. The failed unquoted restart during PR 12
split the Portuguese text at semicolons and lost `--max-iterations` /
`--completion-promise`.

## Codex Monitor Loop

Codex should write a monitor file outside the repo, for example:

```text
~/workspace/c3-oss/prosa-<feature>-ralph-loop-monitor.md
```

When the user reports "Ralph started", "Loop iniciado", or equivalent, Codex
must enter the active monitor loop immediately. Do not only record the start.
Use a 5-minute interval by default unless the user requested a different
interval. The interval is a real idle wait: Codex stops all monitoring work,
runs no intermediate checks, sends no progress updates, and does no parallel
review or implementation work until the wait expires.

Each cycle:

1. Idle for the configured interval.
2. Record timestamp, `git status --short --branch`, recent commits, changed
   areas, lane evidence/status, correction queue, gates, `RALPH_DONE` signal,
   open blockers, and no-change streak in the external monitor.
3. Update `status.md`, `correction-queue.md`, and gate/evidence artifacts as
   needed.
4. Compare implementation against lanes, correction queue, and product
   invariants.
5. Spawn read-only reviewers for changed domains, using GPT-5.5 high or
   stronger when available for security, data integrity, remote reads, and gate
   review.
6. Add or update blocking corrections for every reviewer finding that can break
   product behavior, security, data integrity, parity, or release gates.
7. Reset the no-change streak on implementation changes.

Keep treating Ralph as active until `RALPH_DONE` is detected, the user stops the
run, or three configured idle checks show no implementation change and final
gates begin.

## Files For Each Feature

Use this structure:

```text
  docs/roadmap/<feature>/          # future feature specs
    ralph-loop-prompt.md
    status.md
    correction-queue.md
    gates.md
    evidence/
      lane-01.md
      lane-02.md
```

If the feature is already described by an architecture reference, keep the
long-lived reference under `docs/architecture/` and use the roadmap directory
only for the active implementation plan, correction queue, and evidence.

The templates live in:

```text
.codex/skills/ralph-loop-governor/assets/
```

## Reviewer Lanes

Use subagents with disjoint scopes. This is required for substantial output,
especially at lane boundaries and before final gates:

| Agent | Scope |
| --- | --- |
| `ralph-loop-security-reviewer` | auth, tenant isolation, object routes, device ownership, production config |
| `ralph-loop-promotion-integrity-reviewer` | CAS, raw/source records, manifests, receipts, idempotency, cleanup safety |
| `ralph-loop-remote-read-reviewer` | post-promotion CLI/API read authority and output parity |
| `ralph-loop-e2e-gate-runner` | Docker-backed E2E, DB/object-store evidence, skipped gates |
| `ralph-loop-refactor-integrator` | post-hardening refactors with explicit write scope |

Default reviewer mode is read-only. Only assign write scopes after Ralph stops
or when the user asks Codex to intervene.

Reviewer output must feed steering. Do not leave findings only in chat: copy
blocking findings into `correction-queue.md`, update `status.md`, and restart or
steer Ralph with a correction prompt when needed.

Domain specialists still own domain rules. For server-sync work, include
`prosa-server-sync-specialist` alongside the Ralph Loop reviewers. For read
surface changes, include `prosa-cli-search-specialist`. For raw/CAS boundary
changes, include `prosa-architect`.

## Correction Format

Corrections must be specific enough for an executor. This is a server-sync
example; use the same structure for other domains:

```markdown
### CQ-001: Verify canonical CAS hash before promotion receipt

Severity: critical
Blocking: yes
Status: open
Owner: Ralph

Problem:
The server can emit a promotion receipt without proving that the object store
contains bytes matching the canonical `blake3:<hash of original bytes>` object id.

Risk:
Local cleanup can destroy the only valid copy of raw/CAS data.

Required fix:
- Recompute canonical hash on the server.
- Keep transport hash separate from canonical hash.
- Refuse receipt if any declared object is missing or mismatched.

Acceptance:
- [ ] Test rejects transport hash mismatch.
- [ ] Test rejects canonical hash mismatch after decompression.
- [ ] Test proves cleanup is gated by a receipt with verified counters.

Evidence:
- Commit:
- Tests:
```

## Final Gates

Base gates:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
pnpm audit --audit-level moderate
git diff --check
```

Domain gates come from the matched skill. For server-sync work, `$prosa-server-sync`
adds the Docker-backed E2E harness:

```text
just e2e-up
just e2e
just e2e-cli
just e2e-down
```

If `pnpm audit` fails, classify each advisory as runtime, production, dev
tooling, or transitive before declaring Done.

## Done Rule

Ralph can satisfy `<promise>RALPH_DONE</promise>` only when:

- every lane has evidence;
- no blocking correction remains open;
- required gates are green or classified;
- Docker-backed E2E passed when applicable;
- the worktree state is documented;
- Codex final review has no critical unresolved findings.

Ralph must then perform a mandatory stabilization wait before outputting
`RALPH_DONE`: five consecutive clean cycles, each consisting of `sleep 180`
followed by rereading `correction-queue.md`, `gates.md`, `status.md`,
`git status --short --branch`, and recent commits. Any open blocker, failed
gate, stale evidence, new commit, or unexplained dirty worktree resets the
counter to zero. This creates a minimum 15-minute delay after Ralph first thinks
the work is done and prevents immediate false completion after the executor's
own last change.

If Codex has to patch critical issues directly, mark the section as
`Architect intervention` and rerun the relevant gates.
