// Lane 9 — CQ-161 read-only proof + crash-safe recovery.
//
// 1. The v1 source bundle's manifest.json + SQLite db + raw_sources
//    file list must be byte-equal before and after a successful
//    migration. The migrate path now snapshots the bundle and fails
//    closed if any of those change.
// 2. If the process dies between the archive rename and the final
//    rename, the recovery marker written before the first rename
//    must be enough for the next invocation to restore the v1
//    bundle and reap the temp v2 bundle.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateBundle, migrationMarkerPath, recoverFromMigrationMarker } from '../../../src/cli/v2/migrate/bundle.js'
import { buildV1CodexBundle, mktmp } from './helpers.js'

// `tmpdir` import is unused; mktmp covers the test temp paths.

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

describe('migrateBundle CQ-161: v1 source bundle is not mutated', () => {
  it('archive matches the pre-migration v1 byte image', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    await rm(newPath, { recursive: true, force: true })

    const beforeManifest = await hashFile(join(oldPath, 'manifest.json'))
    const beforeDb = await hashFile(join(oldPath, 'prosa.sqlite'))

    const result = await migrateBundle({ oldPath, newPath })
    expect(result.archivedAt).not.toBeNull()
    const archivedAt = result.archivedAt as string

    // Archive must be byte-equal to the original v1 image. Any
    // mutation (manifest rewrite, db migration) would surface as a
    // mismatched hash.
    const afterManifest = await hashFile(join(archivedAt, 'manifest.json'))
    const afterDb = await hashFile(join(archivedAt, 'prosa.sqlite'))
    expect(afterManifest).toBe(beforeManifest)
    expect(afterDb).toBe(beforeDb)
  }, 60_000)

  it('CQ-161: snapshot detects same-name same-size raw_sources corruption', async () => {
    // Same-name + same-size content corruption (e.g. file replaced
    // with different bytes of identical length) used to slip past the
    // old name/size-only snapshot. The content-hash snapshot must
    // detect this and abort BEFORE archive.
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    await rm(newPath, { recursive: true, force: true })

    const rawSourcesDir = join(oldPath, 'raw', 'sources')
    let targetName = ''
    let targetSize = 0
    const { readdir, stat: statFs } = await import('node:fs/promises')
    const entries = await readdir(rawSourcesDir)
    for (const name of entries) {
      const info = await statFs(join(rawSourcesDir, name))
      if (info.isFile() && info.size > 0) {
        targetName = name
        targetSize = info.size
        break
      }
    }
    expect(targetName).not.toBe('')
    expect(targetSize).toBeGreaterThan(0)

    await expect(
      migrateBundle({
        oldPath,
        newPath,
        _beforeResnapshot: async () => {
          // Overwrite with same-length but different content.
          const corrupted = Buffer.alloc(targetSize, 0x5a)
          await writeFile(join(rawSourcesDir, targetName), corrupted)
        },
      }),
    ).rejects.toMatchObject({ stage: 'validate' })

    // The v1 bundle is still present (no archive happened) so an
    // operator can inspect the bytes.
    const v1Stat = await stat(oldPath)
    expect(v1Stat.isDirectory()).toBe(true)
  }, 60_000)
})

describe('migrateBundle CQ-161: crash recovery between renames', () => {
  it('recoverFromMigrationMarker restores v1 when migrate-bundle died after archive', async () => {
    // Simulate the post-archive, pre-final-rename crash state by hand:
    //  - v1 bundle has been renamed to `<oldPath>-v0-archive-<stamp>`
    //  - newPath still holds the temp v2 bundle (assume non-empty)
    //  - the marker file written before the first rename remains
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    await mkdir(newPath, { recursive: true })
    await writeFile(join(newPath, 'sentinel.txt'), 'temp v2 contents')

    const archivePath = `${oldPath}-v0-archive-crash-stamp`
    const markerPath = migrationMarkerPath(oldPath)
    await rename(oldPath, archivePath)
    await writeFile(markerPath, JSON.stringify({ oldPath, newPath, archivePath, createdAtMs: Date.now() }), 'utf8')

    // Recovery: the v1 bundle is restored at the original path and
    // the temp v2 + marker are removed.
    const result = await recoverFromMigrationMarker(oldPath)
    expect(result.restored).toBe(true)

    const restored = await stat(oldPath)
    expect(restored.isDirectory()).toBe(true)
    expect(await stat(join(oldPath, 'manifest.json'))).toBeDefined()

    const archiveAfter = await stat(archivePath).catch(() => null)
    expect(archiveAfter).toBeNull()
    const newAfter = await stat(newPath).catch(() => null)
    expect(newAfter).toBeNull()
    const markerAfter = await stat(markerPath).catch(() => null)
    expect(markerAfter).toBeNull()
  }, 60_000)

  it('CQ-161: aborts before rename when the v1 source is mutated mid-flight', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    await rm(newPath, { recursive: true, force: true })

    // Tamper a raw_sources file (NOT manifest.json) so the v1 opener
    // succeeds normally; the post-reproject resnapshot must still
    // detect the new file. The tamper runs via the `_beforeResnapshot`
    // hook so the test is deterministic (no setTimeout race).
    const rawSourcesDir = join(oldPath, 'raw', 'sources')

    await expect(
      migrateBundle({
        oldPath,
        newPath,
        _beforeResnapshot: async () => {
          const entries = await (await import('node:fs/promises')).readdir(rawSourcesDir)
          const target = entries[0]
          if (target) {
            await writeFile(join(rawSourcesDir, `${target}.tampered`), 'unexpected operator data')
          }
        },
      }),
    ).rejects.toMatchObject({
      stage: 'validate',
    })
  }, 60_000)

  it('CQ-161: pre-archive crash with marker + oldPath + non-empty newPath reaps newPath and clears marker', async () => {
    // Simulate the pre-archive crash state by hand:
    //  - v1 bundle still at oldPath (the first rename never landed)
    //  - newPath is non-empty (the temp v2 bundle was written but
    //    not yet swapped in)
    //  - marker file is present, identifying the migration owner
    // Recovery must reap the marker-owned newPath BEFORE removing
    // the marker, otherwise the next run would see an unprovable
    // non-empty operator path and refuse.
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    // Non-empty marker-owned temp.
    await writeFile(join(newPath, 'temp-v2-sentinel.txt'), 'in-flight v2 contents')

    const archivePath = `${oldPath}-v0-archive-pre-archive-stamp`
    const markerPath = migrationMarkerPath(oldPath)
    await writeFile(markerPath, JSON.stringify({ oldPath, newPath, archivePath, createdAtMs: Date.now() }), 'utf8')

    const result = await recoverFromMigrationMarker(oldPath)
    // Nothing to restore (oldPath was already in place) but the
    // marker-owned temp directory and marker file must both be gone
    // so the next migration starts clean.
    expect(result.restored).toBe(false)
    const markerAfter = await stat(markerPath).catch(() => null)
    expect(markerAfter).toBeNull()
    const newAfter = await stat(newPath).catch(() => null)
    expect(newAfter).toBeNull()

    // The v1 bundle is still intact at oldPath.
    const oldStat = await stat(oldPath)
    expect(oldStat.isDirectory()).toBe(true)
    expect(await stat(join(oldPath, 'manifest.json'))).toBeDefined()
  }, 60_000)

  it('CQ-161: refuses a pre-existing non-empty newPath that is not migration-owned', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    // Plant operator data inside `newPath` so it is NOT empty and
    // NO recovery marker identifies it.
    await writeFile(join(newPath, 'operator-file.txt'), 'do not delete me')

    await expect(migrateBundle({ oldPath, newPath })).rejects.toMatchObject({
      stage: 'discovery',
    })

    // Operator data must be preserved.
    const preserved = await stat(join(newPath, 'operator-file.txt'))
    expect(preserved.isFile()).toBe(true)
  }, 60_000)

  it('migrateBundle auto-recovers from a stale marker on next invocation', async () => {
    // Stage a crashed migration just like the previous test, then
    // run `migrateBundle` against the same paths. The pre-flight
    // recovery must restore v1 BEFORE openBundleV1 runs, so the
    // fresh migration succeeds.
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')
    await mkdir(newPath, { recursive: true })
    await writeFile(join(newPath, 'sentinel.txt'), 'temp v2 contents')

    const archivePath = `${oldPath}-v0-archive-crash-stamp-2`
    const markerPath = migrationMarkerPath(oldPath)
    await rename(oldPath, archivePath)
    await writeFile(markerPath, JSON.stringify({ oldPath, newPath, archivePath, createdAtMs: Date.now() }), 'utf8')

    const result = await migrateBundle({ oldPath, newPath })
    expect(result.archivedAt).not.toBeNull()
    // The crash recovery removed the stale marker before the new
    // migration ran, so the new run's success leaves no marker
    // behind either.
    const markerAfter = await stat(markerPath).catch(() => null)
    expect(markerAfter).toBeNull()
  }, 60_000)
})
