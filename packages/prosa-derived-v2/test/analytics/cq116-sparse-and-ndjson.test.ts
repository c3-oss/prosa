// CQ-116 regression: analytics runtime against sparse bundles and
// NDJSON-only projection segments.
//
// Two scenarios:
//
//   1. Sparse bundle — only one entity has a Parquet file. The
//      `session_facts` view body LEFT JOINs against many other
//      entities; without typed-empty stubs it crashed with
//      `Catalog Error: Table with name <X> does not exist`.
//
//   2. NDJSON-only bundle — `compile-v2` emits canonical projection
//      segments as `<entity>.prosa-projection.ndjson`. The runtime
//      must read those directly so a fixture-backed compile-v2
//      bundle drives `runAnalyticsExecution` end-to-end.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runAnalyticsExecution } from '../../src/analytics/runtime-executor.js'

type DuckDbModule = typeof import('@duckdb/node-api')
let duckdb: DuckDbModule

beforeAll(async () => {
  duckdb = await import('@duckdb/node-api')
})

async function plantSessionsParquet(bundleRoot: string, epoch: number, count: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'sessions.parquet')
  const conn = await duckdb.DuckDBConnection.create()
  try {
    const lines: string[] = []
    for (let i = 0; i < count; i++) {
      lines.push(
        `('ses_${i}'::VARCHAR, 'codex'::VARCHAR, 'src_${i}'::VARCHAR, 'proj_${i}'::VARCHAR, NULL::VARCHAR, FALSE, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, '2026-01-01T00:00:00Z'::VARCHAR, '2026-01-01T00:00:30Z'::VARCHAR, '/work'::VARCHAR, 'main'::VARCHAR, 'claude-opus-4-7'::VARCHAR, 'claude-opus-4-7'::VARCHAR, 'closed'::VARCHAR, 'high'::VARCHAR, 'raw_${i}'::VARCHAR)`,
      )
    }
    const cols =
      'session_id, source_tool, source_session_id, project_id, parent_session_id, is_subagent, agent_role, agent_nickname, title, start_ts, end_ts, cwd_initial, git_branch_initial, model_first, model_last, status, timeline_confidence, raw_record_id'
    const escaped = path.replace(/'/g, "''")
    await conn.run(`COPY (SELECT * FROM (VALUES ${lines.join(', ')}) AS t(${cols})) TO '${escaped}' (FORMAT PARQUET);`)
  } finally {
    conn.closeSync()
  }
}

/** Write a canonical-projection NDJSON segment for the given entity.
 *  Header line carries `entityType`; the runtime's `WHERE
 *  entityType IS NULL` filter drops it. */
async function plantNdjsonSegment(
  bundleRoot: string,
  epoch: number,
  canonicalEntity: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${canonicalEntity}.prosa-projection.ndjson`)
  const header = JSON.stringify({
    bundleFormat: 2,
    segmentKind: 'projection_ndjson',
    entityType: canonicalEntity,
    rowCount: rows.length,
  })
  const body = [header, ...rows.map((r) => JSON.stringify(r))].join('\n')
  await writeFile(path, `${body}\n`, 'utf-8')
}

describe('CQ-116 sparse + NDJSON analytics runtime', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-cq116-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('sparse bundle with only sessions.parquet materialises every other entity as a typed empty stub', async () => {
    // Pre-CQ-116: `runAnalyticsExecution({view:'session_facts'})`
    // crashed with `Catalog Error: Table with name projects does
    // not exist`. Post-fix: the runtime emits a `SELECT NULL ...
    // WHERE FALSE` stub for every missing entity.
    await plantSessionsParquet(bundleRoot, 0, 2)
    const result = await runAnalyticsExecution({
      bundleRoot,
      view: 'session_facts',
      reportQuery: 'SELECT count(*)::BIGINT AS n FROM session_facts;',
    })
    expect(result.skippedEntities).toEqual([])
    expect(Number((result.rows[0] as { n: bigint | number | string }).n)).toBe(2)
  })

  it('reads canonical-projection NDJSON segments emitted by the v2 importers', async () => {
    // Plant only NDJSON for sessions. The runtime must pick up the
    // file via `read_json_auto` and filter out the header row.
    await plantNdjsonSegment(bundleRoot, 1, 'session', [
      {
        session_id: 'ses_ndjson_1',
        source_tool: 'codex',
        source_session_id: 'src_1',
        project_id: 'proj_1',
        parent_session_id: null,
        parent_resolution: 'unresolved',
        is_subagent: false,
        agent_role: null,
        agent_nickname: null,
        title: 'one',
        summary: null,
        start_ts: '2026-01-01T00:00:00Z',
        end_ts: '2026-01-01T00:00:30Z',
        cwd_initial: '/work/a',
        git_branch_initial: 'main',
        model_first: 'claude-opus-4-7',
        model_last: 'claude-opus-4-7',
        status: 'closed',
        timeline_confidence: 'high',
        raw_record_id: 'raw_1',
      },
      {
        session_id: 'ses_ndjson_2',
        source_tool: 'claude',
        source_session_id: 'src_2',
        project_id: 'proj_2',
        parent_session_id: null,
        parent_resolution: 'unresolved',
        is_subagent: false,
        agent_role: null,
        agent_nickname: null,
        title: 'two',
        summary: null,
        start_ts: '2026-01-01T00:01:00Z',
        end_ts: '2026-01-01T00:01:30Z',
        cwd_initial: '/work/b',
        git_branch_initial: null,
        model_first: 'claude-sonnet-4-6',
        model_last: 'claude-sonnet-4-6',
        status: 'closed',
        timeline_confidence: 'high',
        raw_record_id: 'raw_2',
      },
    ])
    const result = await runAnalyticsExecution({
      bundleRoot,
      view: 'session_facts',
      reportQuery: 'SELECT session_id, source_tool FROM session_facts ORDER BY session_id;',
    })
    expect(result.rows).toEqual([
      { session_id: 'ses_ndjson_1', source_tool: 'codex' },
      { session_id: 'ses_ndjson_2', source_tool: 'claude' },
    ])
  })
})
