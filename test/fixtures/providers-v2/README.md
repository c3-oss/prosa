# Provider v2 Fixture Corpora

Shared fixture corpora for the `@c3-oss/prosa-importers-v2` providers
(Codex, Claude Code, Cursor, Gemini, Hermes). These fixtures back the
cross-provider idempotency conformance test at
`test/conformance/providers-v2-idempotency.test.ts`.

Each subdirectory mirrors the discovery layout the matching provider
expects:

- `codex/`               → `<root>/<rollout>.jsonl` session_meta + envelopes
- `claude/<project>/`    → `<sessionId>.jsonl` main + `<sid>/subagents/agent-<aid>.jsonl` subagent
- `cursor/`              → descriptor JSON describing the `store.db` to build
                           (the conformance test materializes a real SQLite
                           database at test time so the corpus stays
                           reviewable as text)
- `gemini/<project>/`    → `chats/session-*.json` snapshots + `.project_root`
- `hermes/`              → `*.jsonl` line logs and `session_*.json` snapshots

The corpus is intentionally small (a handful of envelopes per provider)
because the conformance test exercises **canonical-projection
idempotency**: each provider runs end-to-end twice against the same
fixture and the projection rows must be byte-identical between runs
(same row counts, same deterministic ids per entity type).

When you change a provider's `parseAndProject` schema in a way that
should change ids (intentional canonical schema bump), update both the
provider code and the assertion that the *two* runs in the conformance
test still agree with each other. Do **not** bake the resulting ids
into the corpus: the test only requires the second run to match the
first.
