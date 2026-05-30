# Prosa Importer Change Prompt

Use this prompt when planning or reviewing a change to an importer.

1. Read `INTENT.md`, `docs/canonical-session.md`, and the relevant
   `docs/sources/<agent>.md`.
2. Identify the exact source records being parsed and the target
   `session.Session` fields they populate.
3. Preserve raw JSONL bytes and hash-based idempotency.
4. Add or update focused tests under `internal/importers/<agent>/`.
5. Run focused importer tests, then `just test-race`.

Report the source-format assumption, the canonical-session fields affected,
and any compatibility risk for previously imported sessions.
