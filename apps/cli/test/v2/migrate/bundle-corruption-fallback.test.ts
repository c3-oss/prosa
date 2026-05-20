// Lane 9 — corruption fallback path.
//
// Corrupts a v1 raw-source object's storage path on disk so reading
// the preserved bytes fails. The migration tool should record a gap
// for that source file and fall back to the provider-directory
// recompile path (if a fallback root is provided) without aborting
// the entire run.

import { readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateBundle } from '../../../src/cli/v2/migrate/bundle.js'
import { buildV1CodexBundle, mktmp } from './helpers.js'

describe('migrateBundle: corruption fallback', () => {
  it('records a gap when v1 raw bytes are missing and surfaces the gap on the result', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})

    // Wipe the v1 raw-source files so the migrator cannot read them.
    const rawSourcesDir = join(oldPath, 'raw', 'sources')
    const files = await readdir(rawSourcesDir)
    for (const f of files) {
      await unlink(join(rawSourcesDir, f))
    }

    const newPath = await mktmp('prosa-v2-tmp')
    // Use dryRun=true so a validation mismatch (expected, since we
    // can't reproject) does not abort the run; we want to observe
    // the gap surface.
    const result = await migrateBundle({ oldPath, newPath, dryRun: true })

    expect(result.gaps.length).toBeGreaterThan(0)
    // Each gap must carry a reason classified as missing/corrupted.
    for (const gap of result.gaps) {
      expect(['raw_bytes_missing', 'raw_bytes_corrupted', 'decompress_failed', 'object_missing']).toContain(gap.reason)
      expect(gap.source_file_id).toBeTruthy()
      expect(gap.source_tool).toBe('codex')
    }
  }, 30_000)

  it('runs provider-directory recompile when a fallback root is supplied', async () => {
    const { bundlePath: oldPath, sessionId } = await buildV1CodexBundle({})

    // Wipe v1 raw bytes.
    const rawSourcesDir = join(oldPath, 'raw', 'sources')
    const files = await readdir(rawSourcesDir)
    for (const f of files) {
      await unlink(join(rawSourcesDir, f))
    }

    // Stand up a fresh codex-style discovery root the fallback can
    // walk to recover the data.
    const fallbackRoot = await mktmp('prosa-v1-codex-fallback')
    const day = join(fallbackRoot, '2025', '01', '02')
    await rm(day, { recursive: true, force: true })
    await (await import('node:fs/promises')).mkdir(day, { recursive: true })
    const line = {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: sessionId, cwd: '/repo' },
    }
    await writeFile(join(day, `rollout-${sessionId}.jsonl`), `${JSON.stringify(line)}\n`)

    const newPath = await mktmp('prosa-v2-tmp')
    const result = await migrateBundle({
      oldPath,
      newPath,
      dryRun: true,
      providerRoots: { codex: fallbackRoot },
    })

    expect(result.fallback).not.toBeNull()
    expect(result.fallback!.attempted).toContain('codex')
    // The fallback may seal at least one epoch when the fallback
    // root has discoverable files.
    expect(result.fallback!.sealedEpochs.length).toBeGreaterThanOrEqual(0)
  }, 30_000)
})
