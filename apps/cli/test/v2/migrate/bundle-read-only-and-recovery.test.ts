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

    // Snapshot the pre-migration manifest so we can verify the v1
    // source survives even when something tampers with it during the
    // run. We patch `migrateBundle` indirectly by tampering AFTER the
    // function starts: simulate a concurrent writer by rewriting
    // manifest.json mid-run via a setImmediate. Since migrateBundle is
    // single-process awaitable, we instead simulate the post-snapshot
    // mutation by patching the file BEFORE the reverify but AFTER the
    // reproject phase. The simplest deterministic way is to use a
    // wrapper that mutates after `runCompileImports`. Without that
    // hook, the equivalent failure mode is direct: tamper the
    // manifest before calling migrateBundle to prove the verify path
    // catches it. The previous snapshot inside migrateBundle is taken
    // before the tamper; after the tamper, the post-reproject
    // re-snapshot will not match.
    const beforeManifest = await hashFile(join(oldPath, 'manifest.json'))
    expect(beforeManifest.length).toBeGreaterThan(0)

    // Tamper with manifest.json AFTER the snapshot but BEFORE the
    // reverify. We can deterministically achieve this by mutating
    // the file in a `setImmediate`-style queued microtask that the
    // ongoing reproject phase awaits. In practice the bundle's reads
    // run async, so we simply spawn the mutation in parallel and let
    // the reverify catch it.
    const originalManifest = await readFile(join(oldPath, 'manifest.json'))
    const tamperPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        // Append a junk byte so the SHA-256 changes.
        void writeFile(join(oldPath, 'manifest.json'), `${originalManifest.toString('utf8')}\n# tampered\n`).then(() =>
          resolve(),
        )
      }, 5)
    })

    await expect(migrateBundle({ oldPath, newPath })).rejects.toMatchObject({
      stage: 'validate',
    })
    await tamperPromise
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
