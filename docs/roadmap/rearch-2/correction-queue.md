# rearch-2 Correction Queue

Updated: 2026-05-19 after cycle reset.

## Open blocking corrections

None currently recorded.

## Historical closeout summary

- CQ-001..CQ-019: Lane 0 foundation/canonical/wire/CI integrity corrections closed.
- CQ-020..CQ-066: Lane 1 local-store integrity, durability, containment, rebuild and evidence corrections closed.
- CQ-067..CQ-082: Lane 2 importer/provider/CLI/idempotency corrections closed; Lane 2 accepted by Codex/governor on 2026-05-19.
- CQ-083..CQ-114: Lane 3 derived-layer scaffolding, SessionBlob, Tantivy planning/status, compaction/audit, CLI/read-surface, maintenance and corruption-gate corrections closed.

## Carry-forward lessons

- A correction blocks `RALPH_DONE` and dependent acceptance, but should not force an empty executor loop if unrelated implementation can continue safely.
- Every blocker claim must include a direct verification command or observable evidence.
- Do not close corrections based only on agent claims; require code, tests and evidence.

## New correction template

```text
### CQ-115: <short title>

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | reviewer

Problem:

Risk:

Required fix:

Acceptance:
- [ ] Code change is present.
- [ ] Focused tests/gates pass.
- [ ] Evidence is recorded in the relevant lane file.
```
