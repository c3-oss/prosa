---
name: prosa-importers
description: Importer normalization workflow for Codex, Claude Code, Gemini CLI, and Cursor sources in prosa. Use when modifying src/importers, source discovery, format-specific types, fixtures, tool matching, subagent relationships, timeline confidence, or importer tests.
---

# Prosa Importers

Use this skill for source format ingestion. Pair with `prosa-store-schema-cas` when importer changes require schema or ID changes.

## Common Pipeline

Every importer should:

1. Discover source files without relying on incomplete auxiliary indexes.
2. Register the source file and preserve its bytes.
3. Create raw records with source locator details: line number, JSON pointer, SQLite row/blob ID, or equivalent.
4. Project records into sessions, events, messages, blocks, tool calls, tool results, artifacts, edges, and search docs.
5. Record import errors without aborting the whole batch when a single file fails.
6. Remain idempotent across repeated imports.

## Source-Specific Rules

- Codex: preserve the event envelope; map `session_meta`, `turn_context`, `response_item`, and `event_msg` without flattening everything into messages. Use `call_id` to match tool calls/results. Model spawned subagents with edges when parent IDs are present.
- Claude: import JSONL files directly; do not trust `sessions-index.json` as the source of truth. Use `uuid`, `parentUuid`, `sessionId`, `agentId`, `isSidechain`, and `sourceToolAssistantUUID` for graph links. Treat `type: "system"` as operational.
- Gemini: treat session JSON as snapshots. Duplicate `sessionId` means versions/snapshots, not independent logical sessions. Preserve `.project_root` when available.
- Cursor: preserve SQLite meta and blobs. Extract JSON blobs when possible, but keep timeline confidence low when ordering depends on undecoded protobuf/root state.

## Fixture and Test Expectations

- Add small deterministic fixtures under `test/fixtures/<source>/`.
- Test message counts, tool call/result matching, artifacts, search docs, and idempotent reimport.
- Include malformed or partial records when changing error handling.
- Avoid reading real user history in tests; use temp bundles from `test/helpers/tmp-bundle.ts`.

## Risk Checks

- Do not invent parent/subagent relationships without evidence.
- Do not index huge outputs directly; create artifacts/previews.
- Do not silently overwrite conflicting source IDs with different content.
- Keep raw roundtrip possible from `raw_record_id` to preserved bytes.
