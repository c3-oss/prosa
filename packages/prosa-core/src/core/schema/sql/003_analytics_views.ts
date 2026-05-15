/**
 * Derived analytics views over canonical projection tables.
 *
 * These views are read models only; importers should continue to write source,
 * raw, and canonical tables directly.
 */
export const SQL_003_ANALYTICS_VIEWS = String.raw`
CREATE VIEW IF NOT EXISTS session_facts AS
WITH turn_counts AS (
  SELECT session_id, count(*) AS turn_count
    FROM turns
   GROUP BY session_id
),
message_counts AS (
  SELECT session_id,
         count(*) AS message_count,
         sum(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_message_count,
         sum(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_message_count
    FROM messages
   GROUP BY session_id
),
tool_call_counts AS (
  SELECT session_id,
         count(*) AS tool_call_count,
         sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS tool_call_error_count
    FROM tool_calls
   GROUP BY session_id
),
tool_result_counts AS (
  SELECT session_id,
         count(*) AS tool_result_count,
         sum(CASE WHEN is_error = 1 OR (exit_code IS NOT NULL AND exit_code <> 0)
                  THEN 1 ELSE 0 END) AS tool_result_error_count,
         sum(COALESCE(duration_ms, 0)) AS tool_duration_ms
    FROM tool_results
   GROUP BY session_id
),
search_doc_counts AS (
  SELECT session_id, count(*) AS search_doc_count
    FROM search_docs
   WHERE session_id IS NOT NULL
   GROUP BY session_id
)
SELECT s.session_id,
       s.source_tool,
       s.source_session_id,
       s.project_id,
       p.display_name AS project_name,
       p.canonical_path AS project_path,
       s.parent_session_id,
       s.is_subagent,
       s.agent_role,
       s.agent_nickname,
       s.title,
       s.start_ts,
       s.end_ts,
       CASE
         WHEN s.start_ts IS NOT NULL AND s.end_ts IS NOT NULL
         THEN ROUND((julianday(s.end_ts) - julianday(s.start_ts)) * 86400, 3)
         ELSE NULL
       END AS duration_seconds,
       s.cwd_initial,
       s.git_branch_initial,
       s.model_first,
       s.model_last,
       s.status,
       s.timeline_confidence,
       sf.path AS source_file_path,
       COALESCE(tc.turn_count, 0) AS turn_count,
       COALESCE(mc.message_count, 0) AS message_count,
       COALESCE(mc.user_message_count, 0) AS user_message_count,
       COALESCE(mc.assistant_message_count, 0) AS assistant_message_count,
       COALESCE(tcc.tool_call_count, 0) AS tool_call_count,
       COALESCE(trc.tool_result_count, 0) AS tool_result_count,
       COALESCE(tcc.tool_call_error_count, 0)
         + COALESCE(trc.tool_result_error_count, 0) AS tool_error_count,
       COALESCE(trc.tool_duration_ms, 0) AS tool_duration_ms,
       COALESCE(sdc.search_doc_count, 0) AS search_doc_count
  FROM sessions s
  LEFT JOIN projects p ON p.project_id = s.project_id
  LEFT JOIN raw_records rr ON rr.raw_record_id = s.raw_record_id
  LEFT JOIN source_files sf ON sf.source_file_id = rr.source_file_id
  LEFT JOIN turn_counts tc ON tc.session_id = s.session_id
  LEFT JOIN message_counts mc ON mc.session_id = s.session_id
  LEFT JOIN tool_call_counts tcc ON tcc.session_id = s.session_id
  LEFT JOIN tool_result_counts trc ON trc.session_id = s.session_id
  LEFT JOIN search_doc_counts sdc ON sdc.session_id = s.session_id;

CREATE VIEW IF NOT EXISTS tool_usage_facts AS
WITH result_rollup AS (
  SELECT tool_call_id,
         session_id,
         count(*) AS tool_result_count,
         max(status) AS result_status,
         max(is_error) AS is_error,
         min(exit_code) AS exit_code,
         sum(COALESCE(duration_ms, 0)) AS duration_ms,
         max(preview) AS preview
    FROM tool_results
   GROUP BY tool_call_id, session_id
)
SELECT tc.tool_call_id,
       tc.session_id,
       s.source_tool,
       s.source_session_id,
       s.project_id,
       p.display_name AS project_name,
       p.canonical_path AS project_path,
       tc.turn_id,
       tc.message_id,
       tc.event_id,
       tc.source_call_id,
       tc.tool_name,
       tc.canonical_tool_type,
       tc.command,
       tc.cwd,
       tc.path,
       tc.query,
       tc.timestamp_start,
       tc.timestamp_end,
       CASE
         WHEN tc.timestamp_start IS NOT NULL AND tc.timestamp_end IS NOT NULL
         THEN ROUND((julianday(tc.timestamp_end) - julianday(tc.timestamp_start)) * 86400, 3)
         ELSE NULL
       END AS call_duration_seconds,
       tc.status AS call_status,
       rr.result_status,
       COALESCE(rr.is_error, 0) AS is_error,
       rr.exit_code,
       rr.duration_ms AS result_duration_ms,
       COALESCE(rr.tool_result_count, 0) AS tool_result_count,
       rr.preview,
       tc.raw_record_id
  FROM tool_calls tc
  LEFT JOIN sessions s ON s.session_id = tc.session_id
  LEFT JOIN projects p ON p.project_id = s.project_id
  LEFT JOIN result_rollup rr ON rr.tool_call_id = tc.tool_call_id;

CREATE VIEW IF NOT EXISTS error_facts AS
SELECT 'tool_result:' || tr.tool_result_id AS error_id,
       'tool_result' AS error_category,
       s.source_tool,
       s.project_id,
       p.display_name AS project_name,
       tr.session_id,
       COALESCE(tc.timestamp_end, tc.timestamp_start) AS timestamp,
       tc.tool_name,
       tc.canonical_tool_type,
       COALESCE(tr.status, tc.status) AS status,
       tr.exit_code,
       NULL AS message,
       tr.preview,
       NULL AS entity_type,
       NULL AS entity_id,
       tr.raw_record_id
  FROM tool_results tr
  LEFT JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id
  LEFT JOIN sessions s ON s.session_id = tr.session_id
  LEFT JOIN projects p ON p.project_id = s.project_id
 WHERE tr.is_error = 1 OR (tr.exit_code IS NOT NULL AND tr.exit_code <> 0)
UNION ALL
SELECT 'import_error:' || CAST(ie.error_id AS TEXT) AS error_id,
       'import_error' AS error_category,
       COALESCE(rr.source_tool, ib.source_tool) AS source_tool,
       NULL AS project_id,
       NULL AS project_name,
       NULL AS session_id,
       ie.occurred_at AS timestamp,
       NULL AS tool_name,
       NULL AS canonical_tool_type,
       ie.kind AS status,
       NULL AS exit_code,
       ie.message,
       NULL AS preview,
       NULL AS entity_type,
       NULL AS entity_id,
       ie.raw_record_id
  FROM import_errors ie
  LEFT JOIN import_batches ib ON ib.batch_id = ie.batch_id
  LEFT JOIN raw_records rr ON rr.raw_record_id = ie.raw_record_id
UNION ALL
SELECT 'uncertainty:' || CAST(u.uncertainty_id AS TEXT) AS error_id,
       'uncertainty' AS error_category,
       NULL AS source_tool,
       NULL AS project_id,
       NULL AS project_name,
       CASE WHEN u.entity_type = 'session' THEN u.entity_id ELSE NULL END AS session_id,
       NULL AS timestamp,
       NULL AS tool_name,
       NULL AS canonical_tool_type,
       u.reason AS status,
       NULL AS exit_code,
       u.reason AS message,
       NULL AS preview,
       u.entity_type,
       u.entity_id,
       NULL AS raw_record_id
  FROM uncertainties u;

CREATE VIEW IF NOT EXISTS model_usage AS
WITH model_events AS (
  SELECT s.source_tool,
         s.project_id,
         p.display_name AS project_name,
         p.canonical_path AS project_path,
         s.session_id,
         NULL AS turn_id,
         s.model_first AS model,
         s.start_ts AS timestamp,
         'session_first' AS observation_type
    FROM sessions s
    LEFT JOIN projects p ON p.project_id = s.project_id
   WHERE s.model_first IS NOT NULL
  UNION ALL
  SELECT s.source_tool, s.project_id, p.display_name, p.canonical_path,
         s.session_id, NULL AS turn_id, s.model_last AS model, s.end_ts AS timestamp,
         'session_last' AS observation_type
    FROM sessions s
    LEFT JOIN projects p ON p.project_id = s.project_id
   WHERE s.model_last IS NOT NULL
  UNION ALL
  SELECT s.source_tool, s.project_id, p.display_name, p.canonical_path,
         t.session_id, t.turn_id, t.model, t.start_ts AS timestamp, 'turn' AS observation_type
    FROM turns t
    LEFT JOIN sessions s ON s.session_id = t.session_id
    LEFT JOIN projects p ON p.project_id = s.project_id
   WHERE t.model IS NOT NULL
  UNION ALL
  SELECT s.source_tool, s.project_id, p.display_name, p.canonical_path,
         m.session_id, m.turn_id, m.model, m.timestamp, 'message' AS observation_type
    FROM messages m
    LEFT JOIN sessions s ON s.session_id = m.session_id
    LEFT JOIN projects p ON p.project_id = s.project_id
   WHERE m.model IS NOT NULL
)
SELECT source_tool,
       project_id,
       project_name,
       project_path,
       model,
       count(DISTINCT session_id) AS session_count,
       count(DISTINCT turn_id) AS turn_count,
       count(*) AS observation_count,
       sum(CASE WHEN observation_type = 'message' THEN 1 ELSE 0 END) AS message_count,
       min(timestamp) AS first_seen_ts,
       max(timestamp) AS last_seen_ts
  FROM model_events
 GROUP BY source_tool, project_id, project_name, project_path, model;

CREATE VIEW IF NOT EXISTS project_activity AS
SELECT s.source_tool,
       s.project_id,
       COALESCE(p.display_name, s.cwd_initial, '(unknown)') AS project_name,
       p.canonical_path AS project_path,
       min(s.start_ts) AS first_session_ts,
       max(COALESCE(s.end_ts, s.start_ts)) AS latest_session_ts,
       count(DISTINCT s.session_id) AS session_count,
       count(DISTINCT CASE WHEN s.timeline_confidence = 'low' THEN s.session_id END)
         AS low_confidence_session_count,
       count(DISTINCT t.turn_id) AS turn_count,
       count(DISTINCT m.message_id) AS message_count,
       count(DISTINCT tc.tool_call_id) AS tool_call_count,
       count(DISTINCT tr.tool_result_id) AS tool_result_count,
       count(DISTINCT CASE
         WHEN tr.is_error = 1 OR (tr.exit_code IS NOT NULL AND tr.exit_code <> 0)
         THEN tr.tool_result_id
       END) AS tool_error_count,
       count(DISTINCT sd.doc_id) AS search_doc_count
  FROM sessions s
  LEFT JOIN projects p ON p.project_id = s.project_id
  LEFT JOIN turns t ON t.session_id = s.session_id
  LEFT JOIN messages m ON m.session_id = s.session_id
  LEFT JOIN tool_calls tc ON tc.session_id = s.session_id
  LEFT JOIN tool_results tr ON tr.session_id = s.session_id
  LEFT JOIN search_docs sd ON sd.session_id = s.session_id
 GROUP BY s.source_tool, s.project_id, p.display_name, s.cwd_initial, p.canonical_path;
`
