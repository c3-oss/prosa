# Ralph Loop: rearch-2 next cycle

## Mission

Continue `rearch-2` from the current cycle-reset state. The next cycle is **Lane 3 runtime executor work**, not more pure-read/audit surface expansion.

## Read first

1. `docs/rearch-2/00-README.md`
2. `docs/rearch-2/04-lane-3-derived-layer.md`
3. `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`
4. `docs/roadmap/rearch-2/status.md`
5. `docs/roadmap/rearch-2/correction-queue.md`
6. `docs/roadmap/rearch-2/gates.md`
7. `docs/roadmap/rearch-2/evidence/lane-03.md`

## Current accepted state

- Lane 0 accepted.
- Lane 1 accepted.
- Lane 2 accepted.
- Lane 3 has extensive support/read/audit code but remains incomplete.

## Required focus

Implement the missing runtime executors from Lane 3:

1. Tantivy native writer / incremental rebuild runtime.
2. DuckDB analytics runtime executor.
3. Parquet compaction merge worker.

Choose one runtime executor slice, implement it fully enough to run focused tests, and commit it with evidence. Do not start another read-only/audit/diagnostic subcommand unless it is directly necessary for the selected runtime executor.

## Blocker verification rule

If you believe work is blocked by native dependencies, package manager policy, environment, or missing APIs, first run a direct smoke test and record the exact command/output. The previous `allowBuilds` blocker claim was wrong; both DuckDB and Tantivy native bindings are available in this workspace.

## Evidence rules

- Keep evidence concise.
- Batch status/pin updates unless closing a blocking CQ.
- Update `evidence/lane-03.md`, `gates.md`, and `status.md` only with current, decision-useful information.
- Do not recreate long chronological logs.

## Completion rule

Do not output `RALPH_DONE` until every Lane 3 gate in `gates.md` is satisfied and the five-cycle stabilization rule completes.
