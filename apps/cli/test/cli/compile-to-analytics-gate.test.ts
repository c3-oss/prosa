// CQ-116 acceptance gate: fixture-backed `compile-v2` produces
// analytics-readable inputs.
//
// Spawns `prosa compile-v2 codex` against a synthetic Codex
// rollout fixture to produce a real v2 bundle with NDJSON
// projection segments, then drives `runAnalyticsExecution` against
// that bundle. Asserts the report query returns the expected row
// counts. Pre-CQ-116 this would have failed with `IO Error: No
// files found that match the pattern …/<entity>.parquet` (or with
// `Catalog Error: Table ... does not exist` for any entity the
// fixture did not produce).

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAnalyticsExecution } from '@c3-oss/prosa-derived-v2'
import { describe, expect, it } from 'vitest'

const CLI_ENTRY = join(__dirname, '..', '..', 'src', 'bin', 'prosa.ts')

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'node',
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', CLI_ENTRY, ...args],
    { encoding: 'utf8', timeout: 90_000 },
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-cli-cq116-'))
}

function codexFixtureJsonl(): string {
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: 'sess_cq116_codex', cwd: '/work/cq116' },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:06.000Z',
      payload: {
        id: 'msg_cq116_user',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'cq116 user prompt' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:07.000Z',
      payload: {
        id: 'msg_cq116_assistant',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'output_text', text: 'cq116 assistant reply' }],
      },
    },
  ]
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
}

describe('CQ-116 compile-to-analytics gate', () => {
  it('runAnalyticsExecution drives session_facts against a real compile-v2 NDJSON bundle', async () => {
    const storeRoot = await tmp()
    const codexRoot = await tmp()
    await mkdir(join(codexRoot, '2025', '01', '02'), { recursive: true })
    await writeFile(join(codexRoot, '2025', '01', '02', 'cq116-rollout.jsonl'), codexFixtureJsonl())

    // compile-v2 codex — emits canonical NDJSON projection segments
    // (no Parquet) so this exercises the NDJSON ingest path in the
    // analytics runtime.
    const compile = runCli(['compile-v2', 'codex', '--store', storeRoot, '--root', codexRoot])
    if (compile.status !== 0) {
      throw new Error(`compile-v2 failed (status=${compile.status}): ${compile.stderr}\nstdout: ${compile.stdout}`)
    }

    // Drive the analytics runtime in-process. session_facts joins
    // sessions/turns/messages/tool_calls/tool_results/events/
    // search_docs/projects/raw_records/source_files — most of these
    // are sparse for a simple codex fixture, so the typed empty
    // stubs (the other half of CQ-116) also get exercised.
    const result = await runAnalyticsExecution({
      bundleRoot: storeRoot,
      view: 'session_facts',
      reportQuery:
        'SELECT source_session_id, source_tool, message_count, user_message_count, assistant_message_count FROM session_facts ORDER BY source_session_id;',
    })
    expect(result.skippedEntities).toEqual([])
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0] as Record<string, unknown>
    // `source_session_id` is the verbatim session id from the
    // fixture (`session_id` is the BLAKE3-derived canonical row id).
    expect(row.source_session_id).toBe('sess_cq116_codex')
    expect(row.source_tool).toBe('codex')
    expect(Number(row.message_count)).toBe(2)
    expect(Number(row.user_message_count)).toBe(1)
    expect(Number(row.assistant_message_count)).toBe(1)
  }, 60_000)
})
