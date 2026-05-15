---
name: ralph-loop-governor
description: Use when preparing, launching, monitoring, steering, or post-reviewing a Claude Ralph Loop implementation run. Applies when the user wants Codex to generate Ralph prompts, lane plans, correction queues, evidence templates, reviewer subagent work, or a repeatable mixed Codex/Claude workflow.
---

# Ralph Loop Governor

Use this skill to turn a large implementation request into a governed Ralph Loop:
Codex plans, monitors, reviews, writes blocking corrections, and runs final gates;
Claude/Ralph does long-running implementation throughput.

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
`/ralph-loop` command to run.

If the request is too vague to produce safe lanes, ask one concise clarifying
question. Otherwise, make conservative assumptions and proceed.

## Core Contract

- Codex is the architect and gatekeeper; Ralph is the executor.
- Ralph must not be the final judge of its own "Done".
- Convert fuzzy goals into lane invariants, acceptance criteria, and tests.
- Every blocking finding becomes a correction with an ID, status, owner, and evidence.
- Final completion requires gates and evidence, not just a clean worktree.

## Setup Workflow

1. Read the feature roadmap, architecture docs, and repository instructions.
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

3. Generate a Ralph kickoff prompt from `assets/ralph-loop-prompt-template.md`.
4. Give the user an exact Claude command. Quote any natural-language prompt:

```text
/ralph-loop "@docs/roadmap/<feature>/ralph-loop-prompt.md" --max-iterations 30 --completion-promise RALPH_DONE
```

5. If restarting Ralph to consume corrections, use a quoted prompt:

```text
/ralph-loop "Read @docs/roadmap/<feature>/ralph-loop-prompt.md, @docs/roadmap/<feature>/correction-queue.md, and @docs/roadmap/<feature>/gates.md. Close every blocking correction with evidence, wait 5 minutes, reread the correction queue, and repeat until no blocking correction remains open." --max-iterations 20 --completion-promise RALPH_DONE
```

## Monitoring Workflow

- Write the monitor outside the repo unless the user asks otherwise, for example:
  `~/workspace/c3-oss/<repo>-<feature>-ralph-loop-monitor.md`.
- Use real idle intervals requested by the user. Do not poll aggressively.
- Each check records: timestamp, `git status --short --branch`, recent commits,
  changed areas, new test evidence, open blockers, and no-change streak.
- If Ralph is making progress, do not edit implementation files.
- If critical blockers persist, update `correction-queue.md` and
  `ralph-loop-prompt.md` so the next loop iteration sees them.
- If three configured idle checks show no implementation changes, treat Ralph as
  finished and run the final gate.

## Reviewer Subagents

Use disjoint reviewer scopes when the change is large:

- `ralph-loop-security-reviewer`: auth, tenant isolation, object routes, config.
- `ralph-loop-promotion-integrity-reviewer`: CAS, raw data, receipts, cleanup.
- `ralph-loop-remote-read-reviewer`: post-promotion read authority and CLI parity.
- `ralph-loop-e2e-gate-runner`: Docker-backed gate and reproducibility evidence.
- `ralph-loop-refactor-integrator`: post-hardening code shape and maintainability.

Default reviewer mode is read-only. Assign write scopes only after Ralph has
stopped or when the user explicitly wants Codex to intervene.

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

For server/API/sync work, prefer Docker-backed gates when available:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
just e2e-up
just e2e
just e2e-cli
just e2e-down
pnpm audit --audit-level moderate
git diff --check
```

Classify audit failures as runtime, production, dev tooling, or transitive.

## Architect Intervention

If Ralph stops with critical blockers:

- label direct Codex fixes as `Architect intervention`;
- keep patches scoped by subsystem;
- rerun focused tests and the final gate;
- separate "Ralph delivered" from "Codex repaired" in the final report.
