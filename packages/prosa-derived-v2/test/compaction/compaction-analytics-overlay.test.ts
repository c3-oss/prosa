// CQ-117 regression: post-compaction consumer visibility.
//
// Plants many small `sessions.parquet` live segments, runs the
// compaction worker (which now writes the compact manifest), then
// drives the analytics runtime and asserts the consumer-visible row
// count remains unchanged across the compaction. Without the CQ-117
// fix, the analytics overlay read both the live segments and the
// compacted output, doubling the visible row set.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runAnalyticsExecution } from '../../src/analytics/runtime-executor.js'
import { runCompaction } from '../../src/compaction/runtime-worker.js'
import { listSupersededSegmentsFromManifests } from '../../src/compaction/superseded.js'

type DuckDbModule = typeof import('@duckdb/node-api')
let duckdb: DuckDbModule

beforeAll(async () => {
  duckdb = await import('@duckdb/node-api')
})

async function plantSessionsParquet(bundleRoot: string, epoch: number, startId: number, count: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'sessions.parquet')
  const conn = await duckdb.DuckDBConnection.create()
  try {
    const valuesLines: string[] = []
    for (let i = 0; i < count; i++) {
      const id = startId + i
      // Carry every column the `session_facts` view body projects so
      // the view's `SELECT s.<col>` clauses bind successfully on the
      // returned VALUES list. `parent_session_id`, `agent_role`, and
      // `agent_nickname` are nullable in the canonical schema.
      const tuple = `('ses_${id}'::VARCHAR, 'codex'::VARCHAR, 'src_${id}'::VARCHAR, 'proj_${id}'::VARCHAR, NULL::VARCHAR, FALSE, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, '2026-01-01T00:00:00Z'::VARCHAR, '2026-01-01T00:00:30Z'::VARCHAR, '/work'::VARCHAR, 'main'::VARCHAR, 'claude-opus-4-7'::VARCHAR, 'claude-opus-4-7'::VARCHAR, 'closed'::VARCHAR, 'high'::VARCHAR, 'raw_${id}'::VARCHAR)`
      valuesLines.push(tuple)
    }
    const escapedPath = path.replace(/'/g, "''")
    const columnList =
      'session_id, source_tool, source_session_id, project_id, parent_session_id, is_subagent, agent_role, agent_nickname, title, start_ts, end_ts, cwd_initial, git_branch_initial, model_first, model_last, status, timeline_confidence, raw_record_id'
    await conn.run(
      `COPY (SELECT * FROM (VALUES ${valuesLines.join(', ')}) AS t(${columnList})) TO '${escapedPath}' (FORMAT PARQUET);`,
    )
  } finally {
    conn.closeSync()
  }
}

/** Plant a minimum-viable parquet for every other canonical entity
 *  table the `session_facts` view body joins against. Each is a
 *  one-row stub keyed by the columns the view actually reads. */
async function plantOtherEntityStubs(bundleRoot: string): Promise<void> {
  const dir = join(bundleRoot, 'epochs', '0', 'projection')
  await mkdir(dir, { recursive: true })
  const conn = await duckdb.DuckDBConnection.create()
  try {
    const writes: Array<[string, string]> = [
      [
        'turns',
        `(SELECT 'turn_x' AS turn_id, 'ses_other' AS session_id, 'claude-opus-4-7' AS model, '2026-01-01T00:00:00Z' AS start_ts)`,
      ],
      [
        'messages',
        `(SELECT 'm_x' AS message_id, 'ses_other' AS session_id, 'turn_x' AS turn_id, 'user' AS role, NULL AS model, '2026-01-01T00:00:00Z' AS timestamp)`,
      ],
      [
        'tool_calls',
        `(SELECT 'tc_x' AS tool_call_id, 'ses_other' AS session_id, 'turn_x' AS turn_id, NULL AS message_id, NULL AS event_id, 'src_x' AS source_call_id, 'bash' AS tool_name, 'shell' AS canonical_tool_type, NULL AS command, NULL AS cwd, NULL AS path, NULL AS query, '2026-01-01T00:00:00Z' AS timestamp_start, '2026-01-01T00:00:01Z' AS timestamp_end, 'ok' AS status, 'raw_x' AS raw_record_id)`,
      ],
      [
        'tool_results',
        `(SELECT 'tr_x' AS tool_result_id, 'tc_x' AS tool_call_id, 'ses_other' AS session_id, 'ok' AS status, FALSE AS is_error, 0 AS exit_code, 0 AS duration_ms, 'hi' AS preview, 'raw_x' AS raw_record_id)`,
      ],
      ['events', `(SELECT 'e_x' AS event_id, 'ses_other' AS session_id, '2026-01-01T00:00:00Z' AS timestamp)`],
      ['search_docs', `(SELECT 'd_x' AS doc_id, 'ses_other' AS session_id)`],
      ['projects', `(SELECT 'proj_x' AS project_id, 'X' AS display_name, '/x' AS canonical_path)`],
      ['raw_records', `(SELECT 'raw_x' AS raw_record_id, 'sf_x' AS source_file_id)`],
      ['source_files', `(SELECT 'sf_x' AS source_file_id, '/x/file.json' AS path)`],
    ]
    for (const [entity, sql] of writes) {
      const out = join(dir, `${entity}.parquet`)
      await conn.run(`COPY ${sql} TO '${out.replace(/'/g, "''")}' (FORMAT PARQUET);`)
    }
  } finally {
    conn.closeSync()
  }
}

describe('CQ-117 compaction analytics overlay', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-cq117-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('preserves the consumer-visible session row count across compaction (33 → 33, not 66)', async () => {
    // Plant 33 small sessions.parquet live segments → fires the
    // policy's `file_count_trigger`.
    for (let epoch = 0; epoch < 33; epoch++) {
      await plantSessionsParquet(bundleRoot, epoch, epoch, 1)
    }
    await plantOtherEntityStubs(bundleRoot)

    // Pre-compaction: the analytics overlay sees 33 sessions.
    const beforeResult = await runAnalyticsExecution({
      bundleRoot,
      view: 'session_facts',
      reportQuery: 'SELECT count(*)::BIGINT AS n FROM sessions;',
    })
    expect(Number((beforeResult.rows[0] as { n: bigint | number | string }).n)).toBe(33)

    // Run the compaction worker — writes the compacted output AND
    // (CQ-117 fix) persists the compact manifest so consumers can
    // discover the superseded live segments.
    const compactionResult = await runCompaction({
      bundleRoot,
      generatedAt: '2026-05-20T00:00:00Z',
    })
    expect(compactionResult.empty).toBe(false)
    expect(compactionResult.manifestPath).not.toBeNull()
    expect(compactionResult.results).toHaveLength(1)
    expect(compactionResult.results[0]?.rowCount).toBe(33)

    // The manifest records all 33 live segments as superseded.
    const superseded = await listSupersededSegmentsFromManifests(bundleRoot)
    expect(superseded).toHaveLength(33)

    // Post-compaction: the analytics overlay must still see 33
    // sessions — the live segments are present on disk but the
    // runtime filters them via the manifest's `superseded[]`.
    const afterResult = await runAnalyticsExecution({
      bundleRoot,
      view: 'session_facts',
      reportQuery:
        'SELECT count(*)::BIGINT AS n, count(DISTINCT session_id)::BIGINT AS distinct_sessions FROM sessions;',
    })
    const afterRow = afterResult.rows[0] as { n: bigint | number | string; distinct_sessions: bigint | number | string }
    expect(Number(afterRow.n)).toBe(33)
    expect(Number(afterRow.distinct_sessions)).toBe(33)
  })

  it('compacted output appears in the overlay even when live segments were unique', async () => {
    // Sanity: same scenario, but confirm the COMPACTED file
    // contributes rows when read alone. This protects against a
    // regression where the runtime over-filters and drops the
    // compacted output too.
    for (let epoch = 0; epoch < 33; epoch++) {
      await plantSessionsParquet(bundleRoot, epoch, epoch, 1)
    }
    await plantOtherEntityStubs(bundleRoot)
    await runCompaction({ bundleRoot, generatedAt: '2026-05-20T00:00:00Z' })
    const result = await runAnalyticsExecution({
      bundleRoot,
      view: 'session_facts',
      reportQuery: "SELECT count(*)::BIGINT AS n FROM sessions WHERE session_id IN ('ses_0', 'ses_15', 'ses_32');",
    })
    expect(Number((result.rows[0] as { n: bigint | number | string }).n)).toBe(3)
  })
})
