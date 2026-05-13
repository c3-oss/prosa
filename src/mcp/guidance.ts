/** System instructions advertised by the MCP server to guide evidence-first use of prosa tools. */
export const PROSA_MCP_INSTRUCTIONS = `
prosa is a local memory over local agent session histories. Use it to find prior work, commands,
decisions, file touches, transcripts, and analytical rollups before answering from memory.

There are six tools:
- search: full-text over messages, commands, paths, diffs, and previews. Start here for open-ended
  questions with 2-5 concrete terms. Optional engine, field_kind, raw, since/until filters.
- sessions: without session_id, lists candidates filtered by source/time/limit. With session_id,
  opens the session: format=detail (default) returns metadata + timeline, format=summary returns
  only the session row, format=markdown renders the full transcript.
- tool_calls: audit commands and tool usage. Filters by tool_name, canonical_type, session_id,
  errors_only. When path_substring is set, also returns artifacts touching that path — use this for
  file-history questions.
- analytics: built-in aggregate reports backed by SQLite views. Pick report=sessions|tools|errors|
  models|projects with the matching filters. Use report=sessions with session_id or
  source_path_substring for per-session metrics.
- artifact: fetch full text for an artifact_id when previews are not enough. Binary artifacts return
  a placeholder.
- compile: with no input, returns a status snapshot (search index health). With source (and
  optionally sessions_path), imports that provider into the bundle. Use status mode when search
  results look stale; use import mode when local sessions may not be indexed yet.

When answering, cite concrete evidence: session_id, timestamp, tool/file path, and the relevant
snippet or event. Do not treat search snippets as the whole truth; open the session with
\`sessions session_id=… format=detail\` when accuracy matters.
`.trim()

/** Prompt template for investigating prior sessions by topic. */
export const INVESTIGATE_PRIOR_WORK_PROMPT = `
Investigate prior work in prosa for the topic: {{topic}}

Use this workflow:
1. Call \`search\` with a short query built from the topic.
2. If results are broad, search again with narrower terms from the best snippets.
3. Open the most relevant session_ids with \`sessions session_id=… format=detail\`.
4. Use \`sessions session_id=… format=markdown\` only for sessions that appear directly relevant.
5. Answer with evidence: session_id, timestamp, and the decisive snippet or event.
`.trim()

/** Prompt template for tracing sessions and tool calls that touched a file or path. */
export const FIND_FILE_HISTORY_PROMPT = `
Investigate history for file/path: {{path}}

Use this workflow:
1. Call \`tool_calls\` with path_substring set to the path or its most distinctive suffix.
2. Open returned session_ids with \`sessions session_id=… format=detail\`.
3. Call \`tool_calls\` with session_id when you need command-level detail inside one session.
4. Use \`sessions session_id=… format=markdown\` only for the most relevant session.
5. Summarize what changed, who/what tool touched it, and cite session_id plus timestamp.
`.trim()

/** Prompt template for grouping failed tool calls and related context by likely cause. */
export const AUDIT_TOOL_FAILURES_PROMPT = `
Audit tool failures in prosa{{query_clause}}.

Use this workflow:
1. For an aggregate report, call \`analytics report=errors\` (filter by source/since/until/tool_name
   as needed).
2. For per-call evidence, call \`tool_calls\` with errors_only=true.
3. If a query is provided, also call \`search\` for that query to find related context.
4. Open relevant session_ids with \`sessions session_id=… format=detail\`.
5. Group failures by tool_name, command/path, and likely cause.
6. Answer with evidence: session_id, timestamp, command/path, exit code, and preview.
`.trim()
