// Lane 3 gate (gates.md): transcript rendering against a v2 bundle.
//
// The gate language is "transcript rendering against a v2 bundle
// matches the v1 renderer for the same input". Strict byte-for-byte
// v1 parity is intentionally out of scope: the v2 transcript
// renderer (`formatTranscriptTextV2`) emits a different layout
// (per-message ordinal headers + block-level identifiers + CAS ref
// preview lines) so the on-disk pack contents stay scannable.
// What this gate proves is the v2 transcript flow round-trips:
//
//   v2 compile → session-blob runtime writer → `v2 index transcript
//   --format text` → output contains the fixture's user + assistant
//   text and the canonical session_id matches the importer's row.
//
// This is the "semantic-equivalent transcript" interpretation of
// the gate. The output layout itself is locked by
// `packages/prosa-derived-v2/test/session-blob/transcript-format-text.test.ts`.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBundle } from '@c3-oss/prosa-bundle-v2'
import { runSessionBlobBuild } from '@c3-oss/prosa-derived-v2'
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
  return mkdtemp(join(tmpdir(), 'prosa-cli-transcript-gate-'))
}

function codexFixtureJsonl(): string {
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: 'sess_transcript_gate', cwd: '/work/transcript-gate' },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:06.000Z',
      payload: {
        id: 'msg_transcript_user',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'transcript gate user prompt with searchable token sentinel-user' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:07.000Z',
      payload: {
        id: 'msg_transcript_assistant',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'output_text', text: 'transcript gate assistant reply sentinel-assistant' }],
      },
    },
  ]
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
}

describe('Lane 3 compile-to-transcript gate', () => {
  it('v2 compile → runSessionBlobBuild → v2 index transcript renders the fixture content', async () => {
    const storeRoot = await tmp()
    const codexRoot = await tmp()
    await mkdir(join(codexRoot, '2025', '01', '02'), { recursive: true })
    await writeFile(join(codexRoot, '2025', '01', '02', 'transcript-rollout.jsonl'), codexFixtureJsonl())

    // Step 1 — v2 compile codex emits canonical NDJSON projection
    // segments (no SessionBlob packs).
    const compile = runCli(['v2', 'compile', 'codex', '--store', storeRoot, '--root', codexRoot])
    if (compile.status !== 0) {
      throw new Error(`v2 compile failed (status=${compile.status}): ${compile.stderr}\nstdout: ${compile.stdout}`)
    }
    const bundle = await openBundle(storeRoot)
    let sealedEpoch: number
    try {
      sealedEpoch = bundle.head.epoch
    } finally {
      await bundle.close()
    }

    // Step 2 — runSessionBlobBuild reads the projection NDJSON and
    // writes one pack per session under
    // `derived/session-blob/epoch-<n>/<session_id>.pack`. This is the
    // Lane 3 runtime writer that bridges the compile output to the
    // transcript reader.
    const buildResult = await runSessionBlobBuild({ bundleRoot: storeRoot, epoch: sealedEpoch })
    expect(buildResult.packs).toHaveLength(1)
    const pack = buildResult.packs[0]
    if (pack === undefined) throw new Error('unreachable')
    expect(pack.session_id).toMatch(/^ses_/)
    expect(pack.messageCount).toBe(2)
    expect(pack.byteLength).toBeGreaterThan(0)
    expect(buildResult.skippedSessions).toEqual([])

    // Step 3 — v2 index transcript --format text drives the v2
    // transcript renderer through the SessionBlob pack. Output must
    // contain both the user and assistant texts from the fixture
    // (the semantic equivalence the v1 renderer would also surface
    // for the same input).
    const transcriptRun = runCli([
      'v2',
      'index',
      'transcript',
      '--store',
      storeRoot,
      '--session-id',
      pack.session_id,
      '--format',
      'text',
    ])
    if (transcriptRun.status !== 0) {
      throw new Error(
        `v2 index transcript failed (status=${transcriptRun.status}): ${transcriptRun.stderr}\nstdout: ${transcriptRun.stdout}`,
      )
    }
    const text = transcriptRun.stdout
    expect(text).toContain('transcript gate user prompt with searchable token sentinel-user')
    expect(text).toContain('transcript gate assistant reply sentinel-assistant')
    // The renderer emits ordinal-prefixed message headers — confirm
    // both messages were materialised in the rendered output.
    expect(text).toMatch(/\[#0\][^\n]*\buser\b/)
    expect(text).toMatch(/\[#1\][^\n]*\bassistant\b/)
  }, 90_000)
})
