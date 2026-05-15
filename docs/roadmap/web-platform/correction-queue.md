# Web Platform Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

No open corrections at kickoff.

## Closed

Move closed corrections here with commit and test evidence.

## Correction Format

### CQ-000: Example title

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | subagent

Problem:
Describe the bug, gap, or unsafe assumption.

Risk:
Explain why it matters for product behavior, data integrity, security, or
maintainability.

Required fix:
- List the concrete required change.

Acceptance:
- [ ] Observable acceptance criterion.
- [ ] Test or command proves it.

Evidence:
- Commit:
- Tests:
- Notes:
