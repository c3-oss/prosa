export const PROSA_MCP_INSTRUCTIONS = `
prosa is a local memory over local agent session histories. Use it to import recent sessions,
find prior work, commands, decisions, file touches, and full transcripts before answering from
memory.

Recommended workflow:
- Use compile to refresh the bundle when recent local sessions may not be indexed yet. With no
  input it imports all supported providers from default paths.
- For open-ended questions, start with search_sessions using 2-5 concrete terms.
- For questions about a file or path, start with find_touched_files, then inspect the returned sessions.
- After search results, call get_session for the most relevant session_ids before drawing conclusions.
- Use export_session_markdown only after selecting a likely session; it can return a large transcript.
- Use session_metrics for per-session audits, custom source-path filters, tool counts, durations,
  errors, and token_count payloads.
- Use list_tool_calls for command history, failed tools, patches, and operational audit trails.
- Use get_artifact only when a returned artifact_id is needed for full output or diff content.
- Use index_status if search results look stale or unexpectedly empty.

When answering, cite concrete evidence: session_id, timestamp, tool/file path, and the relevant snippet
or event. Do not treat search snippets as the whole truth; open the session when accuracy matters.
`.trim();

export const INVESTIGATE_PRIOR_WORK_PROMPT = `
Investigate prior work in prosa for the topic: {{topic}}

Use this workflow:
1. Call search_sessions with a short query built from the topic.
2. If results are broad, search again with narrower terms from the best snippets.
3. Open the most relevant session_ids with get_session.
4. Use export_session_markdown only for sessions that appear directly relevant.
5. Answer with evidence: session_id, timestamp, and the decisive snippet or event.
`.trim();

export const FIND_FILE_HISTORY_PROMPT = `
Investigate history for file/path: {{path}}

Use this workflow:
1. Call find_touched_files with the path or the most distinctive path suffix.
2. Open returned session_ids with get_session.
3. Use list_tool_calls with session_id when you need command-level detail.
4. Use export_session_markdown only for the most relevant session.
5. Summarize what changed, who/what tool touched it, and cite session_id plus timestamp.
`.trim();

export const AUDIT_TOOL_FAILURES_PROMPT = `
Audit tool failures in prosa{{query_clause}}.

Use this workflow:
1. Call list_tool_calls with errors_only=true.
2. If a query is provided, also call search_sessions for that query to find related context.
3. Open relevant session_ids with get_session.
4. Group failures by tool_name, command/path, and likely cause.
5. Answer with evidence: session_id, timestamp, command/path, exit code, and preview.
`.trim();
