# Prosa Importer Change Prompt

Use this prompt when planning or reviewing a change to an importer.

1. Read `INTENT.md` (especially § *In scope (MVP)* and § *Out of scope,
   intentionally*), `docs/architecture/canonical-session.md`,
   `docs/architecture/importers.md`, and the relevant
   `docs/sources/<agent>.md`.
2. Identify the exact source records being parsed and the target
   `session.Session` fields they populate. If a useful field has no
   canonical slot yet, surface that — do not extend the schema
   unilaterally.
3. Preserve raw JSONL bytes byte-for-byte and keep idempotency
   hash-based (sha256 of raw bytes). No per-turn incremental sync.
4. Resolve project identity through the shared helpers (git remote >
   `.prosa.yaml` marker > cwd fallback). Do not re-roll the lookup.
5. Add or update focused tests under `internal/importers/<agent>/`.
   Cover representative records, malformed JSON, partial files,
   sessions with no turns, and the no-op-on-unchanged-hash path.
6. Run focused importer tests, then `just test-race`:

   ```bash
   go test ./internal/importers/<agent>/... -race
   go test ./internal/store/... -race
   just test-race
   ```

Report:

- the source-format assumption (with line references to
  `docs/sources/<agent>.md`),
- the canonical-session fields affected,
- any compatibility risk for previously imported sessions.

For deeper review, invoke `prosa-importer-reviewer`.
