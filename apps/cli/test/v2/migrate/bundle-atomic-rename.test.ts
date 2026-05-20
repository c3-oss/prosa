// Lane 9 — atomic-rename safety.
//
// Simulates a mid-flight failure inside the migration tool by
// pointing the archive path at a regular file. `fs.rename(oldDir,
// existingFile)` returns ENOTDIR on Linux; this is the closest
// in-process analogue to `SIGKILL` between the two renames. The
// test asserts:
//
//   - the v1 bundle remains at its original path,
//   - the temp v2 bundle (`newPath`) is removed by the next run's
//     `reapStaleNewPath` even though the previous run never closed
//     it cleanly.

import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateBundle } from '../../../src/cli/v2/migrate/bundle.js'
import { buildV1CodexBundle, mktmp } from './helpers.js'

describe('migrateBundle: atomic rename safety', () => {
  it('leaves the v1 bundle in place when the rename phase throws', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const newPath = await mktmp('prosa-v2-tmp')

    // Force rename(oldDir -> archivePath) to fail by pointing the
    // archive at an existing regular file. Both Linux and macOS
    // reject a directory-over-file rename, surfacing the exact
    // SIGKILL-between-renames scenario the contract must survive.
    const blockerDir = await mkdtemp(join(tmpdir(), 'prosa-archive-blocker-'))
    const blocker = join(blockerDir, 'blocker.txt')
    await writeFile(blocker, 'blocker')

    await expect(migrateBundle({ oldPath, newPath, archivePath: blocker })).rejects.toBeInstanceOf(Error)

    // v1 bundle still at original path.
    const oldStat = await stat(oldPath)
    expect(oldStat.isDirectory()).toBe(true)

    // The next migrateBundle invocation must clean up the stale
    // `newPath` rather than fail. Run a fresh successful migration
    // pointed at the same paths to assert recovery.
    const result = await migrateBundle({ oldPath, newPath })
    expect(result.archivedAt).not.toBeNull()
    expect(result.validation.ok).toBe(true)
  }, 30_000)
})
