// runAnalyticsExecution end-to-end tests against real Parquet files.
//
// Bootstraps an in-process DuckDB connection per test to write tiny
// canonical-entity Parquet segments under
// `<bundleRoot>/epochs/0/projection/<entity>.parquet`, then drives
// the runtime executor and asserts:
//
//   - the report query returns DuckDB columns in the
//     `ANALYTICS_VIEW_COLUMNS[view]` order;
//   - row counts match the seeded fixtures;
//   - the runtime's `skippedEntities` reporter behaves: zero when
//     every entity has at least one Parquet, populated when a
//     specific entity's parquet glob is empty.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runAnalyticsExecution } from '../../src/analytics/runtime-executor.js'
import {
  ANALYTICS_ENTITY_TABLES,
  ANALYTICS_VIEW_COLUMNS,
  type AnalyticsEntityTable,
} from '../../src/analytics/views.js'

type DuckDbModule = typeof import('@duckdb/node-api')
let duckdb: DuckDbModule

beforeAll(async () => {
  duckdb = await import('@duckdb/node-api')
})

interface EntityFixtures {
  sessions: Record<string, unknown>[]
  turns: Record<string, unknown>[]
  messages: Record<string, unknown>[]
  tool_calls: Record<string, unknown>[]
  tool_results: Record<string, unknown>[]
  events: Record<string, unknown>[]
  search_docs: Record<string, unknown>[]
  projects: Record<string, unknown>[]
  raw_records: Record<string, unknown>[]
  source_files: Record<string, unknown>[]
}

/** Minimal column types for each canonical entity so the planted
 *  Parquet files line up with the columns the view bodies project. */
function defaultRows(): EntityFixtures {
  return {
    sessions: [
      {
        session_id: 'ses_1',
        source_tool: 'codex',
        source_session_id: 'src_1',
        project_id: 'proj_a',
        parent_session_id: null,
        is_subagent: false,
        agent_role: null,
        agent_nickname: null,
        title: 'first session',
        start_ts: '2026-05-19T10:00:00Z',
        end_ts: '2026-05-19T10:05:00Z',
        cwd_initial: '/work/a',
        git_branch_initial: 'main',
        model_first: 'claude-opus-4-7',
        model_last: 'claude-opus-4-7',
        status: 'closed',
        timeline_confidence: 'high',
        raw_record_id: 'raw_1',
      },
      {
        session_id: 'ses_2',
        source_tool: 'claude',
        source_session_id: 'src_2',
        project_id: 'proj_b',
        parent_session_id: null,
        is_subagent: false,
        agent_role: null,
        agent_nickname: null,
        title: 'second session',
        start_ts: '2026-05-19T11:00:00Z',
        end_ts: '2026-05-19T11:02:00Z',
        cwd_initial: '/work/b',
        git_branch_initial: null,
        model_first: 'claude-sonnet-4-6',
        model_last: 'claude-sonnet-4-6',
        status: 'closed',
        timeline_confidence: 'high',
        raw_record_id: 'raw_2',
      },
    ],
    turns: [
      { turn_id: 't_1', session_id: 'ses_1', model: 'claude-opus-4-7', start_ts: '2026-05-19T10:01:00Z' },
      { turn_id: 't_2', session_id: 'ses_1', model: 'claude-opus-4-7', start_ts: '2026-05-19T10:02:00Z' },
      { turn_id: 't_3', session_id: 'ses_2', model: 'claude-sonnet-4-6', start_ts: '2026-05-19T11:01:00Z' },
    ],
    messages: [
      {
        message_id: 'm_1',
        session_id: 'ses_1',
        turn_id: 't_1',
        role: 'user',
        model: null,
        timestamp: '2026-05-19T10:01:00Z',
      },
      {
        message_id: 'm_2',
        session_id: 'ses_1',
        turn_id: 't_1',
        role: 'assistant',
        model: 'claude-opus-4-7',
        timestamp: '2026-05-19T10:01:30Z',
      },
      {
        message_id: 'm_3',
        session_id: 'ses_2',
        turn_id: 't_3',
        role: 'user',
        model: null,
        timestamp: '2026-05-19T11:01:00Z',
      },
    ],
    tool_calls: [
      {
        tool_call_id: 'tc_1',
        session_id: 'ses_1',
        turn_id: 't_1',
        message_id: 'm_2',
        event_id: null,
        source_call_id: 'src_tc_1',
        tool_name: 'bash',
        canonical_tool_type: 'shell',
        command: 'echo hi',
        cwd: '/work/a',
        path: null,
        query: null,
        timestamp_start: '2026-05-19T10:01:31Z',
        timestamp_end: '2026-05-19T10:01:32Z',
        status: 'ok',
        raw_record_id: 'raw_1',
      },
      {
        tool_call_id: 'tc_2',
        session_id: 'ses_1',
        turn_id: 't_2',
        message_id: null,
        event_id: null,
        source_call_id: 'src_tc_2',
        tool_name: 'grep',
        canonical_tool_type: 'search',
        command: null,
        cwd: '/work/a',
        path: '/work/a/file.ts',
        query: 'foo',
        timestamp_start: '2026-05-19T10:02:01Z',
        timestamp_end: '2026-05-19T10:02:03Z',
        status: 'error',
        raw_record_id: 'raw_1',
      },
    ],
    tool_results: [
      {
        tool_result_id: 'tr_1',
        tool_call_id: 'tc_1',
        session_id: 'ses_1',
        status: 'ok',
        is_error: false,
        exit_code: 0,
        duration_ms: 1000,
        preview: 'hi',
        raw_record_id: 'raw_1',
      },
      {
        tool_result_id: 'tr_2',
        tool_call_id: 'tc_2',
        session_id: 'ses_1',
        status: 'error',
        is_error: true,
        exit_code: 1,
        duration_ms: 2000,
        preview: 'no match',
        raw_record_id: 'raw_1',
      },
    ],
    events: [{ event_id: 'e_1', session_id: 'ses_1', timestamp: '2026-05-19T10:01:00Z' }],
    search_docs: [
      { doc_id: 'd_1', session_id: 'ses_1' },
      { doc_id: 'd_2', session_id: 'ses_1' },
      { doc_id: 'd_3', session_id: 'ses_2' },
    ],
    projects: [
      { project_id: 'proj_a', display_name: 'Alpha', canonical_path: '/work/a' },
      { project_id: 'proj_b', display_name: 'Bravo', canonical_path: '/work/b' },
    ],
    raw_records: [
      { raw_record_id: 'raw_1', source_file_id: 'sf_1' },
      { raw_record_id: 'raw_2', source_file_id: 'sf_2' },
    ],
    source_files: [
      { source_file_id: 'sf_1', path: '/work/a/session.json' },
      { source_file_id: 'sf_2', path: '/work/b/session.json' },
    ],
  }
}

/** Write a tiny Parquet file at
 *  `<bundleRoot>/epochs/0/projection/<entity>.parquet` using
 *  DuckDB's `COPY (SELECT * FROM (VALUES …)) TO 'path' (FORMAT PARQUET)`.
 *  We use the in-process binding the runtime itself uses so the
 *  schema written matches what `read_parquet` expects to find. */
async function writeEntityParquet(
  bundleRoot: string,
  entity: AnalyticsEntityTable,
  rows: Record<string, unknown>[],
): Promise<void> {
  const dir = join(bundleRoot, 'epochs', '0', 'projection')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${entity}.parquet`)
  if (rows.length === 0) return
  const conn = await duckdb.DuckDBConnection.create()
  try {
    // Build a VALUES list. DuckDB infers column names from the
    // `AS t(col1, col2, ...)` alias; column types are inferred from
    // the literal values, with explicit `::TYPE` casts where the
    // inference would otherwise pick the wrong type (booleans, ints).
    const columns = Object.keys(rows[0] as Record<string, unknown>)
    const tupleLines: string[] = []
    for (const row of rows) {
      const literals = columns.map((c) => toSqlLiteral((row as Record<string, unknown>)[c]))
      tupleLines.push(`(${literals.join(', ')})`)
    }
    const aliasCols = columns.join(', ')
    const sql = `COPY (SELECT * FROM (VALUES ${tupleLines.join(', ')}) AS t(${aliasCols})) TO ${quote(path)} (FORMAT PARQUET)`
    await conn.run(sql)
  } finally {
    conn.closeSync()
  }
}

function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value === true) return 'TRUE'
  if (value === false) return 'FALSE'
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}` : `${value}::DOUBLE`
  return quote(String(value))
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

async function plantBundle(bundleRoot: string, fixtures: EntityFixtures = defaultRows()): Promise<void> {
  for (const entity of ANALYTICS_ENTITY_TABLES) {
    await writeEntityParquet(bundleRoot, entity, fixtures[entity])
  }
}

describe('runAnalyticsExecution', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-analytics-runtime-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('materialises session_facts with the canonical column order and one row per session', async () => {
    await plantBundle(bundleRoot)
    const result = await runAnalyticsExecution({ bundleRoot, view: 'session_facts' })
    expect(result.view).toBe('session_facts')
    expect(result.columns).toEqual([...ANALYTICS_VIEW_COLUMNS.session_facts])
    expect(result.rows).toHaveLength(2)
    expect(result.skippedEntities).toEqual([])
    const row1 = result.rows.find((r) => r.session_id === 'ses_1') as Record<string, unknown>
    expect(row1).toBeDefined()
    expect(row1.source_tool).toBe('codex')
    expect(row1.project_name).toBe('Alpha')
    expect(Number(row1.turn_count)).toBe(2)
    expect(Number(row1.message_count)).toBe(2)
    expect(Number(row1.user_message_count)).toBe(1)
    expect(Number(row1.assistant_message_count)).toBe(1)
    expect(Number(row1.tool_call_count)).toBe(2)
    expect(Number(row1.tool_result_count)).toBe(2)
    expect(Number(row1.tool_error_count)).toBeGreaterThanOrEqual(2)
    expect(Number(row1.search_doc_count)).toBe(2)
  })

  it('materialises tool_usage_facts with the canonical column order and one row per tool call', async () => {
    await plantBundle(bundleRoot)
    const result = await runAnalyticsExecution({ bundleRoot, view: 'tool_usage_facts' })
    expect(result.columns).toEqual([...ANALYTICS_VIEW_COLUMNS.tool_usage_facts])
    expect(result.rows).toHaveLength(2)
    const error = result.rows.find((r) => r.tool_call_id === 'tc_2') as Record<string, unknown>
    expect(error.is_error).toBe(true)
    expect(Number(error.result_exit_code)).toBe(1)
    expect(Number(error.tool_result_count)).toBe(1)
  })

  it('materialises error_facts only for errored tool results', async () => {
    await plantBundle(bundleRoot)
    const result = await runAnalyticsExecution({ bundleRoot, view: 'error_facts' })
    expect(result.columns).toEqual([...ANALYTICS_VIEW_COLUMNS.error_facts])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.error_id).toBe('tool_result:tr_2')
    expect(result.rows[0]?.error_category).toBe('tool_result')
  })

  it('materialises model_usage with a row per (source_tool, project, model)', async () => {
    await plantBundle(bundleRoot)
    const result = await runAnalyticsExecution({ bundleRoot, view: 'model_usage' })
    expect(result.columns).toEqual([...ANALYTICS_VIEW_COLUMNS.model_usage])
    // session_first + session_last + per-turn + per-message observations
    // for two models across two sessions/projects → two groups.
    expect(result.rows.length).toBeGreaterThanOrEqual(2)
    const opus = result.rows.find((r) => r.model === 'claude-opus-4-7') as Record<string, unknown>
    expect(opus).toBeDefined()
    expect(Number(opus.session_count)).toBe(1)
  })

  it('materialises project_activity with one row per (source_tool, project)', async () => {
    await plantBundle(bundleRoot)
    const result = await runAnalyticsExecution({ bundleRoot, view: 'project_activity' })
    expect(result.columns).toEqual([...ANALYTICS_VIEW_COLUMNS.project_activity])
    expect(result.rows).toHaveLength(2)
    const alpha = result.rows.find((r) => r.project_id === 'proj_a') as Record<string, unknown>
    expect(alpha.project_name).toBe('Alpha')
    expect(Number(alpha.session_count)).toBe(1)
    expect(Number(alpha.tool_error_count)).toBe(1)
  })

  it('CQ-116 sparse-bundle path: entities with no parquet materialise as a typed empty stub and skippedEntities stays empty', async () => {
    // Plant every entity EXCEPT events. Pre-CQ-116 the runtime
    // listed `events` in `skippedEntities`; post-fix it materialises
    // the entity as a `SELECT NULL::VARCHAR AS ... WHERE FALSE`
    // stub so view bodies that LEFT JOIN against it do not crash.
    const fixtures = defaultRows()
    fixtures.events = []
    await plantBundle(bundleRoot, fixtures)
    const result = await runAnalyticsExecution({ bundleRoot, view: 'session_facts' })
    expect(result.skippedEntities).toEqual([])
    expect(result.rows).toHaveLength(2)
  })

  it('runs a caller-supplied reportQuery against the materialised view', async () => {
    await plantBundle(bundleRoot)
    const result = await runAnalyticsExecution({
      bundleRoot,
      view: 'session_facts',
      reportQuery: 'SELECT session_id, source_tool FROM session_facts ORDER BY session_id;',
    })
    expect(result.columns).toEqual(['session_id', 'source_tool'])
    expect(result.rows).toEqual([
      { session_id: 'ses_1', source_tool: 'codex' },
      { session_id: 'ses_2', source_tool: 'claude' },
    ])
  })
})
