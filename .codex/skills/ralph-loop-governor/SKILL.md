---
name: ralph-loop-governor
description: Use when preparing, launching, monitoring, steering, or post-reviewing a Claude Ralph Loop implementation run. Applies when the user wants Codex to generate Ralph prompts, lane plans, correction queues, evidence templates, reviewer subagent work, or a repeatable mixed Codex/Claude workflow.
---

# Ralph Loop Governor

Use this skill to turn a large implementation request into a governed Ralph Loop:
Codex plans, monitors, reviews, writes blocking corrections, and runs final gates;
Claude/Ralph does long-running implementation throughput.

The point of this skill is code review and steering, not passive status
tracking. Codex must actively review Ralph's code with focused subagents,
convert reviewer findings into blocking corrections, and steer Ralph until the
implementation satisfies the lane contract and gates. If Codex is only watching
commits land, it is not using this skill correctly.

## User Invocation

The preferred user-facing interface is terse:

```text
$ralph-loop-governor quero uma feature abc que faça X, Y e Z
```

or:

```text
$ralph-loop-governor implemente <goal>
```

Do not require the user to ask for lanes, prompts, status files, correction
queues, gates, evidence templates, subagents, or Claude commands. Infer and
create those artifacts from the feature request, then return the exact Claude
`/ralph-loop:ralph-loop` command to run. The command must reference the prompt
file only; put every natural-language execution instruction inside
`ralph-loop-prompt.md`, not inside the shell/chat command.

If the request is too vague to produce safe lanes, ask one concise clarifying
question. Otherwise, make conservative assumptions and proceed.

## Core Contract

- Codex is the architect and gatekeeper; Ralph is the executor.
- Ralph must not be the final judge of its own "Done".
- Codex must review code with subagents during the run, not only after Ralph
  claims completion.
- Codex must steer Ralph through `correction-queue.md`,
  `ralph-loop-prompt.md`, and gate updates whenever reviewers find blockers.
- This skill owns Ralph Loop process artifacts. Domain skills own product
  architecture, path ownership, invariants, and domain validation.
- When a feature matches another skill, import that skill into the Ralph prompt
  rather than restating its rules here.
- Convert fuzzy goals into lane invariants, acceptance criteria, and tests.
- Every blocking finding becomes a correction with an ID, status, owner, and evidence.
- Final completion requires gates and evidence, not just a clean worktree.
- Ralph must not output `RALPH_DONE` immediately after it thinks the queue is
  empty. A final stabilization wait is mandatory; see "Executor Completion
  Stabilization" below.

## Setup Workflow

1. Read repository instructions, then read matching domain skills and canonical
   architecture docs before creating the Ralph prompt. For server-sync work,
   read `.codex/skills/prosa-server-sync/SKILL.md` and
   `docs/architecture/server-sync.md`.
2. Create or update this feature workspace:

```text
docs/roadmap/<feature>/
  ralph-loop-prompt.md
  status.md
  correction-queue.md
  gates.md
  evidence/
    lane-01.md
    lane-02.md
```

Use the roadmap directory for active run artifacts only. Durable subsystem
references belong in `docs/architecture/` and should be linked from the Ralph
prompt rather than duplicated.

3. Generate a Ralph kickoff prompt from `assets/ralph-loop-prompt-template.md`.
   The prompt must be self-contained: include the current objective, read-first
   files, open corrections, lane blocking rules, required gates, and completion
   stabilization instructions. Any restart-specific guidance belongs in the
   prompt file as an "Invocation Contract" or equivalent section.
4. Give the user an exact Claude command that contains only the prompt file
   reference and flags. Do not embed natural-language operational instructions
   in the command:

```text
/ralph-loop:ralph-loop @docs/roadmap/<feature>/ralph-loop-prompt.md --max-iterations 30 --completion-promise RALPH_DONE
```

5. If restarting Ralph to consume corrections, first update
   `ralph-loop-prompt.md` so it names the files to read, the blocking
   corrections to close, and the stabilization rule. Then give a terse command:

```text
/ralph-loop:ralph-loop @docs/roadmap/<feature>/ralph-loop-prompt.md --max-iterations 20 --completion-promise RALPH_DONE
```

For server-sync follow-up work, a good terse user prompt is:

```text
$ralph-loop-governor continuar server-sync usando docs/architecture/server-sync.md, ROADMAP.md e $prosa-server-sync como contexto
```

## Monitoring Workflow

- Write the monitor outside the repo unless the user asks otherwise, for example:
  `~/workspace/c3-oss/<repo>-<feature>-ralph-loop-monitor.md`.
- When the user reports "Ralph started", "Loop iniciado", or equivalent, enter
  the active monitor loop immediately. Do not only record the start.
- Use a 5-minute interval by default unless the user requested a different
  interval. The interval is a real idle wait: stop all monitoring work, do not
  run intermediate checks, do not send progress updates, and do not do parallel
  review or implementation work until the wait expires.
- Each check records in the external monitor: timestamp,
  `git status --short --branch`, recent commits, changed areas, lane
  evidence/status, correction queue, gates, `RALPH_DONE` signal, open blockers,
  and no-change streak.
- Update `status.md`, `correction-queue.md`, and gate/evidence artifacts as
  needed after each check.
- After material implementation changes or completed lanes, spawn focused
  read-only reviewer subagents for the changed domains. Use GPT-5.5 high or
  stronger when available for security, data integrity, remote reads, and final
  gate review.
- If Ralph is making progress, do not edit implementation files.
- If reviewer findings or Codex review reveal blockers, immediately add or
  update entries in `correction-queue.md` with concrete acceptance criteria and
  update `ralph-loop-prompt.md` when the executor needs stronger steering.
- Keep treating Ralph as active until `RALPH_DONE` is detected, the user stops
  the run, or three configured idle checks show no implementation changes and
  final gates begin.

## Executor Completion Stabilization

Ralph/Claude must perform a final stabilization wait before satisfying
`RALPH_DONE`. This rule exists because the executor can make a change, believe
the run is complete, and then miss stale evidence, gate drift, or newly written
Codex corrections.

When Ralph believes there are no open blocking corrections:

1. Commit or explicitly document all WIP. Do not begin stabilization with an
   unexplained dirty worktree.
2. Run and record the required focused gates for the run.
3. Start a clean-cycle counter at zero.
4. Repeat until the counter reaches five:
   - sleep exactly 180 seconds;
   - reread `correction-queue.md`, `gates.md`, `status.md`, `git status
     --short --branch`, and recent commits;
   - if there is any open blocker, dirty/unexplained worktree state, new commit,
     failed gate, stale evidence, or contradictory status, fix it and reset the
     counter to zero;
   - if everything is still clean and consistent, increment the counter by one.
5. Only after five consecutive clean cycles, which is at least 15 minutes, may
   Ralph output `RALPH_DONE`.

Codex should reject `RALPH_DONE` if this five-cycle stabilization evidence is
missing, shorter than 15 minutes, or reset conditions were ignored.

## Reviewer Subagents

Reviewer subagents are mandatory for substantial Ralph output. Use disjoint
reviewer scopes as soon as material code lands, at lane boundaries, and before
any final gate:

- `ralph-loop-security-reviewer`: auth, tenant isolation, device ownership, object-route abuse, production config.
- `ralph-loop-promotion-integrity-reviewer`: CAS/manifests, raw/source declarations, receipts, idempotency, cleanup safety.
- `ralph-loop-remote-read-reviewer`: post-promotion read authority, output parity, fail-closed behavior.
- `ralph-loop-e2e-gate-runner`: Docker-backed gate and reproducibility evidence.
- `ralph-loop-refactor-integrator`: post-hardening code shape and maintainability.

Pair these process reviewers with domain specialists. For example, server-sync
work should also use `prosa-server-sync-specialist`; remote read work may also
need `prosa-cli-search-specialist`; local CAS/raw boundary work may also need
`prosa-architect`.

Default reviewer mode is read-only. Assign write scopes only after Ralph has
stopped or when the user explicitly wants Codex to intervene.

Reviewer findings are not advisory notes to remember later. Every finding that
can break product behavior, security, data integrity, parity, or release gates
must become a `CQ-*` correction before the next Ralph restart or final review.
After writing corrections, Codex must steer the executor: update status, point
Ralph at the correction queue, and refuse `RALPH_DONE` until the corrections are
closed with code, tests, and evidence.

## Correction Queue Rules

Use `assets/correction-queue-template.md` for formatting.

Every blocking correction needs:

- stable ID such as `CQ-001`;
- severity and blocking flag;
- concrete file paths or commands;
- product or security risk;
- required fix;
- acceptance criteria;
- evidence field with commits and tests.

Do not close a correction because an agent claims it is fixed. Close it only when
code, tests, and evidence support the claim.

## Evidence And Gates

Use `assets/lane-evidence-template.md` and `assets/gates-template.md`.

Start with the base gates:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
pnpm audit --audit-level moderate
git diff --check
```

Add domain gates from the matched skill. For server-sync work, `$prosa-server-sync`
adds Docker-backed E2E:

```text
just e2e-up
just e2e
just e2e-cli
just e2e-down
```

Classify audit failures as runtime, production, dev tooling, or transitive.

## Architect Intervention

If Ralph stops with critical blockers:

- label direct Codex fixes as `Architect intervention`;
- keep patches scoped by subsystem;
- rerun focused tests and the final gate;
- separate "Ralph delivered" from "Codex repaired" in the final report.
