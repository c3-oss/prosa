// Lane 9 — v1 -> v2 bundle migration roundtrip.
//
// Compiles a synthetic Codex rollout into a v1 bundle, migrates it
// to v2, and asserts: load-bearing counts match, the v1 archive
// exists, the v2 bundle is openable, and the v2 head reflects the
// re-projected source_file + session counts.

import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBundle as openBundleV2 } from '@c3-oss/prosa-bundle-v2'
import { describe, expect, it } from 'vitest'

import { migrateBundle } from '../../../src/cli/v2/migrate/bundle.js'
import { buildV1CodexBundle, mktmp } from './helpers.js'

describe('migrateBundle: roundtrip', () => {
  it('migrates a v1 codex bundle to v2 with matching load-bearing counts', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')

    const result = await migrateBundle({ oldPath, newPath })

    // v1 bundle moved to <oldPath>-v0-archive-<ts>
    expect(result.archivedAt).not.toBeNull()
    expect(result.archivedAt!).toMatch(/-v0-archive-/)
    const archiveStat = await stat(result.archivedAt!)
    expect(archiveStat.isDirectory()).toBe(true)

    // v2 bundle now lives at the v1 path
    expect(result.v2Path).toBe(oldPath)

    // Load-bearing counts match
    expect(result.validation.ok).toBe(true)
    expect(result.validation.diff.sourceFiles).toBe(0)
    expect(result.validation.diff.rawRecords).toBe(0)
    expect(result.validation.diff.sessions).toBe(0)

    // Opening the v2 bundle works and head.counts reflects the re-projection
    const v2 = await openBundleV2(result.v2Path, { readOnly: true })
    try {
      expect(v2.head.epoch).toBeGreaterThanOrEqual(1)
      expect(v2.head.counts.sourceFiles).toBe(result.validation.v1Counts.sourceFiles)
      expect(v2.head.counts.sessions).toBe(result.validation.v1Counts.sessions)
    } finally {
      await v2.close()
    }
  }, 30_000)

  it('records per-phase timings for --verbose/--json output', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')

    const result = await migrateBundle({ oldPath, newPath })
    const phases = result.phases.map((p) => p.phase)
    expect(phases).toContain('discovery')
    expect(phases).toContain('reproject')
    expect(phases).toContain('validate')
    expect(phases).toContain('rename')
    for (const p of result.phases) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0)
    }
  }, 30_000)

  it('dry-run leaves the v1 bundle in place and writes the v2 bundle next to it', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')

    const result = await migrateBundle({ oldPath, newPath, dryRun: true })

    expect(result.archivedAt).toBeNull()
    expect(result.v2Path).toBe(newPath)
    const oldStat = await stat(oldPath)
    expect(oldStat.isDirectory()).toBe(true)
    const newStat = await stat(newPath)
    expect(newStat.isDirectory()).toBe(true)

    // The temp dir prefix used by migrateBundle should not have leaked
    // anywhere unexpected; both v1 and v2 are intact.
    const entries = await readdir(newPath)
    expect(entries).toContain('head.json')
  }, 30_000)
})
