# Lane Focus, Blocker Verification, and Cycle Reset

Use this with `ralph-loop-governor` after the 2026-05-19 Prosa overnight run.

## Rules

- Keep one named current milestone.
- Classify work as core milestone, required support, or premature/later-lane surface.
- Pure-read/audit/diagnostic surfaces are support; they do not complete runtime executor deliverables.
- If three consecutive commits are support/premature work, stop and redirect to the core milestone.
- Verify dependency/environment/service blockers with a direct smoke command before rerouting.
- Batch routine evidence/status pins unless closing a blocking CQ.
- Between long cycles, consolidate wrap-ups into one roadmap handoff and delete root scratch/control files.

## Reusable prompt clause

```text
Do not add more pure-read/audit/diagnostic surfaces unless they are directly required for the selected core milestone. If you believe the core milestone is blocked, first run a direct smoke test and record the exact output. A blocker claim without a command is not accepted.
```
