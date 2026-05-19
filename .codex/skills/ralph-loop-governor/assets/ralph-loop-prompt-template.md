# Ralph Loop: <feature name>

You are implementing `<feature name>` in this repository.

Codex is acting as architect and gatekeeper. It may update correction and gate
files while you work. Treat those files as blocking input.

Codex will actively review your code with focused subagents and steer this run
through `correction-queue.md`, `gates.md`, and updates to this prompt. Those
review findings are part of the implementation contract, not optional advice.
Expect Codex to reject `RALPH_DONE` if subagent findings remain open.

## Invocation Contract

This prompt is intentionally self-contained. When Ralph is launched with
`/ralph-loop:ralph-loop @docs/roadmap/<feature>/ralph-loop-prompt.md`, treat
this section as the full kickoff/restart instruction:

- Read this prompt, `docs/roadmap/<feature>/correction-queue.md`,
  `docs/roadmap/<feature>/gates.md`, `docs/roadmap/<feature>/status.md`, and
  every feature source document listed below.
- Close every implementable blocking correction with code, tests, and evidence.
  Blocking corrections prevent final acceptance, `RALPH_DONE`, and dependent
  downstream lane acceptance; they do not forbid independent useful work that
  cannot invalidate the blocked decision.
- Do not count out-of-sequence or downstream WIP as accepted progress while any
  prerequisite lane or correction remains open.
- If a blocker depends on Codex/governor accepting or rejecting an architecture
  re-scope, ask a single explicit binary question with a safe default. Example:
  `Decision needed: accept the NDJSON projection re-scope? Default: reject and
  implement Parquet.`
- If no independent useful work remains after asking that binary question, stop
  and wait for the answer. Do not continue empty iterations that only repeat
  "waiting for Codex" or "external acceptance required".
- In this prompt, "Codex" means the governor/reviewer available through
  correction-queue steering, not an unavailable third party.
- If no blocking correction remains, run the mandatory final stabilization
  wait: five clean cycles of sleep 180 seconds, then reread correction queue,
  gates, status, git status, and recent commits.
- Output `RALPH_DONE` only after all lanes are complete, all blockers are
  closed, required gates pass or are classified, and the five cycles stay clean.

## Read First

- AGENTS.md
- docs/roadmap/<feature>/
- <matching Codex skills, e.g. .codex/skills/prosa-server-sync/SKILL.md>
- <canonical architecture docs, e.g. docs/architecture/server-sync.md>
- <add feature-specific docs>

## Current Milestone

Current milestone: `<one concrete deliverable, not a broad lane name>`.

Every implementation slice must be classified as one of:

- core milestone work;
- required support work;
- premature/later-lane surface area.

Do not add pure-read/audit/diagnostic surfaces unless they are directly required for this milestone. If you believe the milestone is blocked, first run a direct smoke test and record the exact output. A blocker claim without a command is not accepted.

## Product Contract

- <invariant 1>
- <invariant 2>
- <invariant 3>

## Work Lanes

1. <lane 1>
2. <lane 2>
3. <lane 3>

At the start of each iteration:

- inspect `git status --short --branch`;
- identify the first incomplete lane or open correction;
- reread `correction-queue.md` and treat every `Blocking: yes` correction as
  higher priority than dependent new feature work;
- continue independent work only when it cannot invalidate the open blocker;
- continue from there without restarting completed work;
- preserve user changes and unrelated agent changes;
- do not touch generated directories by hand.

## Required Files

Keep these files current:

- `docs/roadmap/<feature>/status.md`
- `docs/roadmap/<feature>/correction-queue.md`
- `docs/roadmap/<feature>/gates.md`
- `docs/roadmap/<feature>/evidence/lane-N.md`

## Implementation Rules

- Follow local repo conventions.
- Commit coherent lane/correction changes.
- Add or update tests with each meaningful behavior change.
- Close reviewer findings with code, tests, and evidence; do not mark a
  correction closed because the implementation "looks right".
- Do not leave destructive behavior guarded only by optimistic assumptions.
- If a command cannot run, document the blocker and add a reproducible fallback
  when possible.
- Do not reroute work based on an unverified blocker. For dependency/environment
  claims, run a direct smoke command first and paste the output into evidence.
- Batch routine evidence/status hash pins unless closing a blocking CQ; avoid one
  status-only commit per implementation commit.

## Required Gates

Before Done, run or explicitly classify the base gates:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
pnpm audit --audit-level moderate
git diff --check
```

Also run the domain gates required by the matched skill. For server-sync, that
usually means:

```text
just e2e-up
just e2e
just e2e-cli
just e2e-down
```

## Completion Rule

Only satisfy the completion promise when the statement is true. With the Ralph
Loop plugin, that means outputting exactly:

```text
<promise>RALPH_DONE</promise>
```

when every lane is implemented, every blocking correction is closed with
evidence, required gates are green or classified, and the worktree state is
documented.

Before outputting `RALPH_DONE`, you must also complete the final stabilization
wait:

1. Confirm there are no open blocking corrections and no unexplained dirty
   worktree changes.
2. Run or record the required gates.
3. Perform five consecutive clean cycles:
   - sleep exactly 180 seconds;
   - reread `correction-queue.md`, `gates.md`, `status.md`,
     `git status --short --branch`, and recent commits;
   - if any blocker, failed gate, stale evidence, new commit, or unexplained
     dirty worktree state appears, fix it and reset the cycle count to zero;
   - otherwise count that as one clean cycle.
4. Only after five clean cycles (minimum 15 minutes) may you output
   `RALPH_DONE`.

Do not output `RALPH_DONE` immediately after closing a correction or making a
commit. Missing stabilization evidence is a false completion.
