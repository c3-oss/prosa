// Analytics view shape contract tests.
//
// Locks the canonical names + column shapes that downstream CLI /
// MCP / web read paths depend on. The view bodies must remain
// DuckDB-executable, but execution is out of scope for this
// iteration (no `@duckdb/node-api` dep yet); these tests pin the
// stable structural surface.

import { describe, expect, it } from 'vitest'

import {
  ANALYTICS_ENTITY_TABLES,
  ANALYTICS_VIEW_COLUMNS,
  ANALYTICS_VIEW_NAMES,
  analyticsParquetPreamble,
  analyticsViewSql,
  parquetReadFor,
} from '../../src/analytics/views.js'

describe('analytics view shape contract', () => {
  it('exports exactly the five canonical v1 view names in order', () => {
    expect([...ANALYTICS_VIEW_NAMES]).toEqual([
      'session_facts',
      'tool_usage_facts',
      'error_facts',
      'model_usage',
      'project_activity',
    ])
  })

  it('every name has a non-empty column-shape contract', () => {
    for (const name of ANALYTICS_VIEW_NAMES) {
      const cols = ANALYTICS_VIEW_COLUMNS[name]
      expect(cols).toBeDefined()
      expect(cols.length).toBeGreaterThan(0)
    }
  })

  it('column-shape lists contain no duplicates per view', () => {
    for (const name of ANALYTICS_VIEW_NAMES) {
      const cols = ANALYTICS_VIEW_COLUMNS[name]
      expect(new Set(cols).size).toBe(cols.length)
    }
  })

  it('session_facts exposes the v1 contract column set', () => {
    expect([...ANALYTICS_VIEW_COLUMNS.session_facts]).toEqual([
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
    ])
  })

  it('every view body is a CREATE OR REPLACE VIEW … AS … statement that names the view', () => {
    for (const name of ANALYTICS_VIEW_NAMES) {
      const sql = analyticsViewSql(name)
      expect(sql).toMatch(new RegExp(`CREATE OR REPLACE VIEW ${name} AS`, 'i'))
      // Each view body must end with a `;` so the runtime can chain it
      // after the preamble.
      expect(sql.endsWith(';')).toBe(true)
    }
  })

  it('view bodies do not use SQLite-specific syntax that DuckDB would reject', () => {
    // The v1 statements used `julianday`, `CAST(x AS TEXT)`, and `is_error = 1` /
    // `is_error = 0`. The v2 port must rewrite all of those.
    for (const name of ANALYTICS_VIEW_NAMES) {
      const sql = analyticsViewSql(name)
      expect(sql).not.toMatch(/\bjulianday\b/)
      expect(sql).not.toMatch(/CAST\s*\([^)]*\bAS\s+TEXT\b/i)
      // is_error is a BOOLEAN in canonical v2; comparisons against the
      // integer literal 1 only appear in v1 SQLite.
      expect(sql).not.toMatch(/is_error\s*=\s*1\b/)
    }
  })

  it('every view body references one or more canonical entity tables only', () => {
    const canonical = new Set<string>(ANALYTICS_ENTITY_TABLES)
    for (const name of ANALYTICS_VIEW_NAMES) {
      const sql = analyticsViewSql(name).toLowerCase()
      // Pick FROM/JOIN target identifiers that look like simple
      // entity names (no Parquet read calls). The preamble is what
      // binds them to Parquet; the view bodies refer to the CTE
      // aliases.
      const matches = sql.match(/\b(?:from|join)\s+([a-z_]+)\b/g) ?? []
      const targets = matches.map((m) => m.replace(/^(?:from|join)\s+/i, ''))
      // Allow CTE-local names (e.g. `result_rollup`, `model_events`,
      // `turn_counts`, `message_counts`, `tool_call_counts`,
      // `tool_result_counts`, `search_doc_counts`) — they appear in
      // the same statement under a WITH clause. Only flag references
      // to identifiers that are neither canonical nor a CTE-local
      // alias.
      const withClauseAliases = Array.from(sql.matchAll(/\b([a-z_]+)\s+as\s*\(/g)).map((m) => m[1] ?? '')
      const allowed = new Set<string>([
        ...canonical,
        ...withClauseAliases,
        's',
        'p',
        't',
        'm',
        'tc',
        'tr',
        'sd',
        'rr',
        'sf',
      ])
      for (const target of targets) {
        // Subqueries can reference `(`; ignore those.
        if (target === '(' || target === '') continue
        expect(allowed).toContain(target)
      }
    }
  })

  it('parquetReadFor builds a stable, union-tolerant read for each entity table', () => {
    for (const entity of ANALYTICS_ENTITY_TABLES) {
      const sql = parquetReadFor('/tmp/bundle', entity)
      expect(sql).toContain(`read_parquet('/tmp/bundle/epochs/*/projection/${entity}.parquet'`)
      expect(sql).toContain('union_by_name => true')
    }
  })

  it('analyticsParquetPreamble emits one TEMP VIEW per canonical entity table, idempotently', () => {
    const preamble = analyticsParquetPreamble('/tmp/bundle')
    for (const entity of ANALYTICS_ENTITY_TABLES) {
      expect(preamble).toContain(`CREATE OR REPLACE TEMP VIEW ${entity} AS SELECT * FROM read_parquet(`)
    }
    // Idempotent: same bundle root yields byte-identical SQL.
    expect(analyticsParquetPreamble('/tmp/bundle')).toBe(preamble)
  })
})
