// Lane 3 governance gate: fixture-backed compile-to-index flow.
//
// Drives the full chain the governor's "Tantivy compile-to-index
// gate" requires:
//
//   1. Spawn `prosa compile-v2 codex` against a synthetic Codex
//      rollout fixture that contains at least one user message
//      whose content_block carries indexable text.
//   2. Spawn `prosa index-v2 tantivy` against the resulting v2
//      bundle. The runtime reads the importer-produced
//      `epochs/<n>/projection/search_doc.prosa-projection.ndjson`,
//      runs `@oxdev03/node-tantivy-binding`, and persists the
//      checkpoint.
//   3. Spawn `prosa index-v2 status` and assert
//      `tantivy.ready_for_read === true` with
//      `indexed_doc_count === source_doc_count >= 1`.
//
// The test deliberately bypasses planted projection segments —
// `apps/cli/test/cli/index-v2.test.ts` already covers that path —
// to exercise the real importer → projection-segment → Tantivy
// runtime → status round trip end-to-end.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBundle } from '@c3-oss/prosa-bundle-v2'
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
  return mkdtemp(join(tmpdir(), 'prosa-cli-gate-'))
}

/**
 * Build a Codex rollout JSONL that the v2 importer turns into one
 * session, one turn, one user message, and one content block with
 * indexable text. That message-with-text is what
 * `buildSearchDocs` lifts into a `SearchDocV2` so the Tantivy
 * runtime has something to index.
 */
function codexFixtureJsonl(): string {
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: 'sess_gate_codex', cwd: '/work/gate' },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:06.000Z',
      payload: {
        id: 'msg_gate_user',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compile to index gate user prompt' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:07.000Z',
      payload: {
        id: 'msg_gate_assistant',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'output_text', text: 'gate assistant reply with indexable text' }],
      },
    },
  ]
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
}

describe('Lane 3 compile-to-index gate', () => {
  it('compile-v2 → index-v2 tantivy → index-v2 status reports ready_for_read with matching counts', async () => {
    const storeRoot = await tmp()
    const codexRoot = await tmp()
    await mkdir(join(codexRoot, '2025', '01', '02'), { recursive: true })
    await writeFile(join(codexRoot, '2025', '01', '02', 'gate-rollout.jsonl'), codexFixtureJsonl())

    // Step 1 — compile-v2 codex.
    const compile = runCli(['compile-v2', 'codex', '--store', storeRoot, '--root', codexRoot])
    if (compile.status !== 0) {
      throw new Error(`compile-v2 failed (status=${compile.status}): ${compile.stderr}\nstdout: ${compile.stdout}`)
    }
    const compileSummary = JSON.parse(compile.stdout) as {
      sealedEpoch: number
      perProvider: Array<{ source_tool: string; discovered: number; won: number }>
    }
    expect(compileSummary.sealedEpoch).toBe(1)
    expect(compileSummary.perProvider[0]?.won).toBe(1)

    // Verify the importer actually emitted a search_doc projection
    // segment. Without this guard, a regression that drops the
    // segment would surface only as "no_search_docs" from the
    // runtime — the gate would silently degrade.
    const bundle = await openBundle(storeRoot)
    let sealedEpoch: number
    try {
      sealedEpoch = bundle.head.epoch
    } finally {
      await bundle.close()
    }
    const projectionPath = join(
      storeRoot,
      'epochs',
      String(sealedEpoch),
      'projection',
      'search_doc.prosa-projection.ndjson',
    )
    const segmentBody = await readFile(projectionPath, 'utf-8')
    const nonHeaderLines = segmentBody.split('\n').filter((l) => l.length > 0)
    // Header + at least one search_doc row.
    expect(nonHeaderLines.length).toBeGreaterThanOrEqual(2)

    // Step 2 — index-v2 tantivy. Use the small writer tuning so the
    // 15 MB / 1-thread floor stays well under any realistic CI cap.
    const indexRun = runCli([
      'index-v2',
      'tantivy',
      '--store',
      storeRoot,
      '--heap-bytes',
      '15000000',
      '--num-threads',
      '1',
    ])
    if (indexRun.status !== 0) {
      throw new Error(
        `index-v2 tantivy failed (status=${indexRun.status}): ${indexRun.stderr}\nstdout: ${indexRun.stdout}`,
      )
    }
    const indexResult = JSON.parse(indexRun.stdout) as {
      kind: string
      sourceDocCount?: number
      result?: {
        kind: string
        plan: { kind: string }
        indexedDocCount?: number
        checkpoint: {
          status: string
          indexed_doc_count: number | null
          source_doc_count: number | null
          last_indexed_epoch: number | null
        }
      }
    }
    expect(indexResult.kind).toBe('ran')
    expect(indexResult.result?.kind).toBe('rebuilt')
    expect(indexResult.result?.plan.kind).toBe('full')
    expect(indexResult.result?.checkpoint.status).toBe('ready')
    expect(indexResult.result?.checkpoint.last_indexed_epoch).toBe(sealedEpoch)
    expect(indexResult.sourceDocCount).toBeGreaterThanOrEqual(1)
    expect(indexResult.result?.indexedDocCount).toBe(indexResult.sourceDocCount)
    expect(indexResult.result?.checkpoint.indexed_doc_count).toBe(indexResult.result?.checkpoint.source_doc_count)

    // Step 3 — index-v2 status. The governor's gate.
    const status = runCli(['index-v2', 'status', '--store', storeRoot])
    if (status.status !== 0) {
      throw new Error(`index-v2 status failed (status=${status.status}): ${status.stderr}\nstdout: ${status.stdout}`)
    }
    const statusSnapshot = JSON.parse(status.stdout) as {
      tantivy: {
        ready_for_read: boolean
        index_dir_valid: boolean
        checkpoint_present: boolean
        checkpoint?: {
          indexed_doc_count: number | null
          source_doc_count: number | null
          last_indexed_epoch: number | null
          status: string
        }
        schema_fingerprint_match: boolean
      }
    }
    expect(statusSnapshot.tantivy.ready_for_read).toBe(true)
    expect(statusSnapshot.tantivy.index_dir_valid).toBe(true)
    expect(statusSnapshot.tantivy.schema_fingerprint_match).toBe(true)
    expect(statusSnapshot.tantivy.checkpoint?.status).toBe('ready')
    expect(statusSnapshot.tantivy.checkpoint?.last_indexed_epoch).toBe(sealedEpoch)
    expect(statusSnapshot.tantivy.checkpoint?.indexed_doc_count).toBe(
      statusSnapshot.tantivy.checkpoint?.source_doc_count,
    )
    expect(statusSnapshot.tantivy.checkpoint?.indexed_doc_count).toBe(indexResult.sourceDocCount)
  }, 90_000)
})
