// DuckDB analytics view definitions for bundle v2.
//
// The lane-doc contract is *column-shape parity with v1*: every v2
// view must expose the same names, the same columns, and the same
// column order, so downstream CLI / MCP / web read paths can switch
// between v1 (SQLite-backed) and v2 (Parquet-backed) without
// re-writing their queries. The SQL bodies below are DuckDB ports of
// the v1 statements in `packages/prosa-core/src/core/schema/sql/003_analytics_views.ts`;
// they read from Parquet projection segments under a configurable
// base path so the runtime can swap between the live `epochs/*/projection/`
// layout and a compacted `epochs/compact-*/projection/` overlay
// without code changes.
//
// This module deliberately ships only the SQL strings and the
// column-shape contract — no DuckDB connection management, no live
// query execution. The runtime worker (`runAnalyticsView`) lands in
// a follow-up iteration when `@duckdb/node-api` is wired into the
// package; the column shapes are the stable invariant that
// downstream code can rely on now.

/** Canonical names of the five fixed analytics reports. */
export const ANALYTICS_VIEW_NAMES = [
  'session_facts',
  'tool_usage_facts',
  'error_facts',
  'model_usage',
  'project_activity',
] as const

export type AnalyticsViewName = (typeof ANALYTICS_VIEW_NAMES)[number]

/**
 * Canonical column-shape contract per view. Every value is the
 * ordered list of column names the view must expose; the runtime
 * `CREATE OR REPLACE VIEW` statements must produce these columns
 * in this order. Downstream code (Lanes 6/7) reads by column name,
 * but column order is also locked so any drift fails a snapshot
 * test immediately.
 */
export const ANALYTICS_VIEW_COLUMNS: Record<AnalyticsViewName, readonly string[]> = {
  session_facts: [
    'session_id',
    'source_tool',
    'source_session_id',
    'project_id',
    'project_name',
    'project_path',
    'parent_session_id',
    'is_subagent',
    'agent_role',
    'agent_nickname',
    'title',
    'start_ts',
    'end_ts',
    'duration_seconds',
    'cwd_initial',
    'git_branch_initial',
    'model_first',
    'model_last',
    'status',
    'timeline_confidence',
    'source_file_path',
    'turn_count',
    'message_count',
    'user_message_count',
    'assistant_message_count',
    'tool_call_count',
    'tool_result_count',
    'tool_error_count',
    'tool_duration_ms',
    'search_doc_count',
  ],
  tool_usage_facts: [
    'tool_call_id',
    'session_id',
    'source_tool',
    'source_session_id',
    'project_id',
    'project_name',
    'project_path',
    'turn_id',
    'message_id',
    'event_id',
    'source_call_id',
    'tool_name',
    'canonical_tool_type',
    'command',
    'cwd',
    'path',
    'query',
    'timestamp_start',
    'timestamp_end',
    'call_duration_seconds',
    'call_status',
    'result_status',
    'is_error',
    'result_exit_code',
    'result_duration_ms',
    'tool_result_count',
    'preview',
    'raw_record_id',
  ],
  error_facts: [
    'error_id',
    'error_category',
    'source_tool',
    'project_id',
    'project_name',
    'session_id',
    'timestamp',
    'tool_name',
    'canonical_tool_type',
    'status',
    'exit_code',
    'message',
    'preview',
    'entity_type',
    'entity_id',
    'raw_record_id',
  ],
  model_usage: [
    'source_tool',
    'project_id',
    'project_name',
    'project_path',
    'model',
    'session_count',
    'turn_count',
    'observation_count',
    'message_count',
    'first_seen_ts',
    'last_seen_ts',
  ],
  project_activity: [
    'source_tool',
    'project_id',
    'project_name',
    'project_path',
    'first_session_ts',
    'latest_session_ts',
    'session_count',
    'low_confidence_session_count',
    'turn_count',
    'message_count',
    'tool_call_count',
    'tool_result_count',
    'tool_error_count',
    'search_doc_count',
  ],
}

/** Compile-time guard: every name in `ANALYTICS_VIEW_NAMES` must
 *  have a column list, and vice versa. */
for (const name of ANALYTICS_VIEW_NAMES) {
  if (!ANALYTICS_VIEW_COLUMNS[name]) {
    throw new Error(`analytics view ${name} has no column-shape contract`)
  }
}

/**
 * Canonical entity table names referenced by the views. The runtime
 * binds each one to a Parquet read via
 * `read_parquet('<bundleBase>/<entity>.parquet')` (plus any compacted
 * overlay). Exported so tests can verify the view SQL only references
 * these stable identifiers.
 */
export const ANALYTICS_ENTITY_TABLES = [
  'sessions',
  'turns',
  'messages',
  'tool_calls',
  'tool_results',
  'events',
  'search_docs',
  'projects',
  'raw_records',
  'source_files',
] as const

export type AnalyticsEntityTable = (typeof ANALYTICS_ENTITY_TABLES)[number]

/** Build a Parquet read glob for a canonical entity table. */
export function parquetReadFor(bundleRoot: string, entity: AnalyticsEntityTable): string {
  // The glob covers both live epochs and any compacted overlays.
  return `read_parquet('${bundleRoot}/epochs/*/projection/${entity}.parquet', union_by_name => true)`
}

/** SQL preamble that defines the v2 entity CTEs from the Parquet
 *  projection segments. Used by every view SQL string so individual
 *  views can stay close to the v1 statement shapes. */
export function analyticsParquetPreamble(bundleRoot: string): string {
  const lines: string[] = []
  for (const entity of ANALYTICS_ENTITY_TABLES) {
    lines.push(`CREATE OR REPLACE TEMP VIEW ${entity} AS SELECT * FROM ${parquetReadFor(bundleRoot, entity)};`)
  }
  return lines.join('\n')
}

/**
 * Build the `CREATE OR REPLACE VIEW` SQL for a single analytics
 * view. The body is a DuckDB port of the v1 statement with two
 * substitutions:
 *
 *   - SQLite `julianday(a) - julianday(b)` → DuckDB
 *     `EPOCH(b::TIMESTAMP) - EPOCH(a::TIMESTAMP)` (still emits seconds).
 *   - `CAST(x AS TEXT)` → `CAST(x AS VARCHAR)`.
 *
 * The runtime worker materialises each view by running the
 * preamble first (so the entity CTEs are bound to Parquet reads),
 * then this SQL.
 */
export function analyticsViewSql(name: AnalyticsViewName): string {
  return VIEW_BODIES[name]
}

const SESSION_FACTS_SQL = String.raw`
CREATE OR REPLACE VIEW session_facts AS
WITH turn_counts AS (
  SELECT session_id, count(*) AS turn_count FROM turns GROUP BY session_id
),
message_counts AS (
  SELECT session_id,
         count(*) AS message_count,
         sum(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_message_count,
         sum(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_message_count
    FROM messages GROUP BY session_id
),
tool_call_counts AS (
  SELECT session_id,
         count(*) AS tool_call_count,
         sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS tool_call_error_count
    FROM tool_calls GROUP BY session_id
),
tool_result_counts AS (
  SELECT session_id,
         count(*) AS tool_result_count,
         sum(CASE WHEN is_error OR (exit_code IS NOT NULL AND exit_code <> 0) THEN 1 ELSE 0 END) AS tool_result_error_count,
         sum(COALESCE(duration_ms, 0)) AS tool_duration_ms
    FROM tool_results GROUP BY session_id
),
search_doc_counts AS (
  SELECT session_id, count(*) AS search_doc_count
    FROM search_docs WHERE session_id IS NOT NULL GROUP BY session_id
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
         THEN ROUND(EPOCH(s.end_ts::TIMESTAMP) - EPOCH(s.start_ts::TIMESTAMP), 3)
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
       COALESCE(tcc.tool_call_error_count, 0) + COALESCE(trc.tool_result_error_count, 0) AS tool_error_count,
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
`.trim()

const TOOL_USAGE_FACTS_SQL = String.raw`
CREATE OR REPLACE VIEW tool_usage_facts AS
WITH result_rollup AS (
  SELECT tool_call_id,
         session_id,
         count(*) AS tool_result_count,
         max(status) AS result_status,
         bool_or(is_error) AS is_error,
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
         THEN ROUND(EPOCH(tc.timestamp_end::TIMESTAMP) - EPOCH(tc.timestamp_start::TIMESTAMP), 3)
         ELSE NULL
       END AS call_duration_seconds,
       tc.status AS call_status,
       rr.result_status,
       COALESCE(rr.is_error, false) AS is_error,
       rr.exit_code AS result_exit_code,
       rr.duration_ms AS result_duration_ms,
       COALESCE(rr.tool_result_count, 0) AS tool_result_count,
       rr.preview,
       tc.raw_record_id
  FROM tool_calls tc
  LEFT JOIN sessions s ON s.session_id = tc.session_id
  LEFT JOIN projects p ON p.project_id = s.project_id
  LEFT JOIN result_rollup rr ON rr.tool_call_id = tc.tool_call_id;
`.trim()

const ERROR_FACTS_SQL = String.raw`
CREATE OR REPLACE VIEW error_facts AS
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
 WHERE tr.is_error OR (tr.exit_code IS NOT NULL AND tr.exit_code <> 0);
`.trim()

const MODEL_USAGE_SQL = String.raw`
CREATE OR REPLACE VIEW model_usage AS
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
`.trim()

const PROJECT_ACTIVITY_SQL = String.raw`
CREATE OR REPLACE VIEW project_activity AS
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
         WHEN tr.is_error OR (tr.exit_code IS NOT NULL AND tr.exit_code <> 0)
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
`.trim()

const VIEW_BODIES: Record<AnalyticsViewName, string> = {
  session_facts: SESSION_FACTS_SQL,
  tool_usage_facts: TOOL_USAGE_FACTS_SQL,
  error_facts: ERROR_FACTS_SQL,
  model_usage: MODEL_USAGE_SQL,
  project_activity: PROJECT_ACTIVITY_SQL,
}
