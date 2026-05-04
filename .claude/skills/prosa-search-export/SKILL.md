---
name: prosa-search-export
description: Search, session listing, TUI/MCP read surfaces, and export guidance for prosa. Use when modifying search services, sessions services, export services, CLI output commands, FTS5 search_docs behavior, Markdown exports, or user-facing read/query flows.
---

# Prosa Search Export

Use this skill for read surfaces built on the canonical store. Search and exports are derived views, not sources of truth.

## Search Rules

- Query `search_docs` joined to `search_docs_fts`; keep metadata in `search_docs`, not only inside FTS text.
- Default user queries should be escaped for FTS5 unless an explicit raw mode is added or used.
- Preserve useful filters by session, project, timestamp, role, tool name, canonical tool type, and field kind.
- Index conversation text, commands, paths, error previews, summaries, and relevant metadata.
- Do not push full large tool outputs into FTS. Store full bytes in CAS and index previews or classified chunks only.

## Session Listing

- Keep list and count filters consistent.
- Prefer stable columns for CLI output: timestamp, source tool, session ID, model, message/tool counts, cwd, and title.
- Validate source filters against known tools: `cursor`, `codex`, `claude`, `gemini`.

## Markdown Export

- Export should be readable and provenance-preserving.
- Include source tool, prosa session ID, source session ID, start/end, cwd, git branch, model span, and timeline confidence.
- Render messages in timeline order and show tool calls near their owning messages when possible.
- For large outputs, show preview and object references instead of dumping every byte.
- If timeline confidence is low, make that visible in the export.

## Validation

- Add focused tests for escaping FTS queries, snippets, filters, low-confidence timeline display, and large output previews.
- Compare exported Markdown snapshots only when the output is intentionally stable.
- Use temp stores and fixture imports; avoid relying on host history.
