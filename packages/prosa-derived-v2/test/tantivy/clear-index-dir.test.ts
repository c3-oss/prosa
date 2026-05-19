// Tantivy index-dir reset tests.
//
// `clearTantivyIndexDir` wipes `<bundleRoot>/derived/tantivy/index`
// before a `full` rebuild. The tests cover idempotency on a fresh
// bundle, recursive removal of stale segments + meta, refusal to
// traverse a symlinked index path (CQ-094 hardening), refusal to
// clear a regular file planted at the index path, and the final
// post-condition: an empty directory exists so the native writer can
// open it immediately.

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearTantivyIndexDir,
  tantivyIndexDir,
  tantivyIndexDirIsValid,
  tantivyMetaPath,
} from '../../src/tantivy/index-dir.js'

describe('clearTantivyIndexDir', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-clear-index-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('creates an empty index directory on a fresh bundle (idempotent)', async () => {
    await clearTantivyIndexDir(bundleRoot)
    const dir = tantivyIndexDir(bundleRoot)
    const dirStat = await lstat(dir)
    expect(dirStat.isDirectory()).toBe(true)
    expect(dirStat.isSymbolicLink()).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('is idempotent across repeated invocations on a fresh bundle', async () => {
    await clearTantivyIndexDir(bundleRoot)
    await clearTantivyIndexDir(bundleRoot)
    await clearTantivyIndexDir(bundleRoot)
    expect(await readdir(tantivyIndexDir(bundleRoot))).toEqual([])
  })

  it('removes stale segment files and a prior meta.json, leaving an empty directory', async () => {
    const dir = tantivyIndexDir(bundleRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(tantivyMetaPath(bundleRoot), JSON.stringify({ segments: [{ segment_id: 'a' }] }))
    await writeFile(join(dir, 'seg-a.store'), 'old segment bytes')
    await mkdir(join(dir, 'subdir'), { recursive: true })
    await writeFile(join(dir, 'subdir', 'nested'), 'nested bytes')

    await clearTantivyIndexDir(bundleRoot)

    expect(await readdir(dir)).toEqual([])
    // The probe must now report `false` — `meta.json` is gone.
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('CQ-094: refuses to clear when the index path is a symlink to an external dir', async () => {
    // Plant a real external directory with real contents; the helper
    // must NOT remove that target. The recursive `rm` would otherwise
    // walk through the symlink and delete the operator's data.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-clear-ext-'))
    try {
      await writeFile(join(external, 'sentinel'), 'do not delete')
      await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
      await symlink(external, tantivyIndexDir(bundleRoot))

      await expect(clearTantivyIndexDir(bundleRoot)).rejects.toThrow(/symlink/i)

      // External target survives unchanged.
      expect(await readFile(join(external, 'sentinel'), 'utf-8')).toBe('do not delete')
      // The symlink at the index path is left intact for the operator
      // to investigate.
      const linkStat = await lstat(tantivyIndexDir(bundleRoot))
      expect(linkStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-096: refuses to operate when `derived/tantivy` is a symlink with no `index` yet (must not create `<external>/index`)', async () => {
    // Without intermediate containment, `mkdir(<bundle>/derived/tantivy/index)`
    // would resolve `tantivy` through the symlink and create
    // `<external>/index` outside the bundle. The clear helper must
    // refuse before that happens.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-clear-mid-'))
    try {
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'tantivy'))

      await expect(clearTantivyIndexDir(bundleRoot)).rejects.toThrow(/CQ-096|intermediate/i)

      // External target survives unchanged: no `index` was created.
      expect(await readdir(external)).toEqual([])
      const linkStat = await lstat(join(bundleRoot, 'derived', 'tantivy'))
      expect(linkStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-096: refuses to operate when `derived` is a symlink (must not mutate the external tree)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-clear-top-'))
    try {
      await writeFile(join(external, 'sentinel'), 'do not touch')
      await symlink(external, join(bundleRoot, 'derived'))

      await expect(clearTantivyIndexDir(bundleRoot)).rejects.toThrow(/CQ-096|intermediate/i)

      // External tree intact.
      expect(await readFile(join(external, 'sentinel'), 'utf-8')).toBe('do not touch')
      const linkStat = await lstat(join(bundleRoot, 'derived'))
      expect(linkStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-096: clears successfully when bundle root is opened via a symlinked alias and the derived tree is a real directory', async () => {
    // Deployment pattern: operator opens the bundle through a
    // symlinked alias. The intermediate containment check targets
    // symlinks inside `derived/`, not the caller's bundle root.
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-clear-alias-'))
    try {
      // Pre-populate the real bundle with a stale index.
      const dir = tantivyIndexDir(bundleRoot)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'stale.bin'), 'old')

      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)

      // Clear via the symlinked alias.
      await clearTantivyIndexDir(aliasRoot)

      // The real bundle's index is now empty.
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('refuses to clear when the index path exists as a regular file', async () => {
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(tantivyIndexDir(bundleRoot), 'something planted here')

    await expect(clearTantivyIndexDir(bundleRoot)).rejects.toThrow(/not a directory/i)

    // The stray file is left in place — the helper must not silently
    // overwrite a surface it does not recognise.
    const fileStat = await lstat(tantivyIndexDir(bundleRoot))
    expect(fileStat.isFile()).toBe(true)
  })

  it('removes symlinked children in place without traversing them (rm recursive semantics)', async () => {
    // Children of a real index directory may be symlinks (e.g.
    // generated by a buggy writer). The helper relies on
    // `fs.rm({ recursive: true })` not following symlinks: the link
    // is unlinked in place; the target survives.
    const dir = tantivyIndexDir(bundleRoot)
    await mkdir(dir, { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-clear-child-ext-'))
    try {
      await writeFile(join(external, 'sentinel'), 'survives')
      await symlink(join(external, 'sentinel'), join(dir, 'broken-segment.lnk'))

      await clearTantivyIndexDir(bundleRoot)

      expect(await readdir(dir)).toEqual([])
      // External target survives unchanged.
      expect(await readFile(join(external, 'sentinel'), 'utf-8')).toBe('survives')
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('leaves the bundle-derived parent directory intact after a fresh reset', async () => {
    // Other derived surfaces (analytics, session-blob) live alongside
    // `derived/tantivy/index`. The reset must not touch the sibling
    // surfaces.
    const analyticsDir = join(bundleRoot, 'derived', 'analytics')
    await mkdir(analyticsDir, { recursive: true })
    await writeFile(join(analyticsDir, 'view-shape.json'), '{}')

    await clearTantivyIndexDir(bundleRoot)

    expect(await readFile(join(analyticsDir, 'view-shape.json'), 'utf-8')).toBe('{}')
  })
})
