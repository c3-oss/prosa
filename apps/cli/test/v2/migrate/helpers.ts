// Shared helpers for Lane 9 migration tests.
//
// `buildV1CodexBundle` runs the v1 Codex importer against a tiny
// synthetic rollout root so each test starts with a fresh v1 bundle
// containing real source_files + raw_records + sessions and the
// preserved raw bytes under `<bundle>/raw/sources/<blake3>.zst`.
//
// Tests can then call `migrateBundle` against the result to exercise
// the v1 -> v2 path.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeBundle, initBundle, runCompileImports } from '@c3-oss/prosa-core'

/** Build a tiny v1 bundle by compiling a single Codex rollout. */
export async function buildV1CodexBundle(opts: {
  bundlePath?: string
  sessionId?: string
}): Promise<{ bundlePath: string; sessionId: string }> {
  const bundlePath = opts.bundlePath ?? (await mkdtemp(join(tmpdir(), 'prosa-v1-bundle-')))
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'prosa-v1-codex-'))
  const sessionId = opts.sessionId ?? `sess_codex_${Math.random().toString(36).slice(2, 10)}`
  await mkdir(join(sessionsRoot, '2025', '01', '02'), { recursive: true })
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: sessionId, cwd: '/repo' },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:06.000Z',
      payload: { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    },
  ]
  await writeFile(
    join(sessionsRoot, '2025', '01', '02', `rollout-${sessionId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  )

  const bundle = await initBundle(bundlePath)
  try {
    await runCompileImports({
      bundle,
      providers: [
        {
          name: 'codex',
          description: 'codex',
          pathHelp: '',
          defaultSessionsPath: () => sessionsRoot,
          compile: (await import('@c3-oss/prosa-core')).getCompileProvider('codex').compile,
        },
      ],
      sessionsPath: sessionsRoot,
    })
  } finally {
    closeBundle(bundle)
  }
  return { bundlePath, sessionId }
}

/** Generate a fresh temp dir path without creating it. */
export async function mktmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}
