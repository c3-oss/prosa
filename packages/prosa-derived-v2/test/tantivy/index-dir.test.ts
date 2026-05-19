// Tantivy index-dir probe tests.
//
// `tantivyIndexDirIsValid` is a fast best-effort probe that returns
// the boolean the rebuild planner needs to decide between `full` and
// `incremental`. The tests cover every false-y path (missing dir,
// missing meta, garbage JSON, non-object root, missing `segments`,
// non-array `segments`, file-not-dir) plus the happy path.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { tantivyIndexDir, tantivyIndexDirIsValid, tantivyMetaPath } from '../../src/tantivy/index-dir.js'

async function writeMeta(bundleRoot: string, contents: string): Promise<void> {
  await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
  await writeFile(tantivyMetaPath(bundleRoot), contents)
}

describe('tantivyIndexDirIsValid', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-dir-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns false when the index directory does not exist', async () => {
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns false when the index path exists as a regular file rather than a directory', async () => {
    // Make sure the parent exists, then drop a file where the
    // directory should be.
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(tantivyIndexDir(bundleRoot), 'not a directory')
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns false when the directory exists but meta.json is missing', async () => {
    await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns false when meta.json exists but is not valid JSON', async () => {
    await writeMeta(bundleRoot, '{ not really json')
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns false when meta.json parses as a JSON array, not an object', async () => {
    await writeMeta(bundleRoot, '[]')
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns false when meta.json is a JSON object missing the `segments` field', async () => {
    await writeMeta(bundleRoot, JSON.stringify({ schema: { fields: [] } }))
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns false when `segments` is not an array', async () => {
    await writeMeta(bundleRoot, JSON.stringify({ segments: 'one' }))
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('returns true when the directory exists with a meta.json containing an empty segments array', async () => {
    await writeMeta(bundleRoot, JSON.stringify({ segments: [] }))
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(true)
  })

  it('returns true when meta.json contains a populated segments array', async () => {
    await writeMeta(
      bundleRoot,
      JSON.stringify({
        segments: [
          { segment_id: 'a', max_doc: 100 },
          { segment_id: 'b', max_doc: 50 },
        ],
        schema: { fields: [] },
      }),
    )
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(true)
  })

  it('returns false when the index path is a dangling symlink', async () => {
    // Plant a symlink whose target does not exist. With `lstat` the
    // probe rejects symlinks unconditionally — CQ-094 — and the
    // dangling target never gets resolved.
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await symlink(join(bundleRoot, 'derived', 'tantivy', 'no-such-target'), tantivyIndexDir(bundleRoot))
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
  })

  it('CQ-094: returns false when the index dir is a symlink to a valid external directory', async () => {
    // Plant a real directory outside the bundle root with a
    // plausible `meta.json`. If the probe followed the symlink, it
    // would report `true` even though the index path escapes the
    // bundle. With `lstat`, the symlink at the index path is
    // rejected unconditionally.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-ext-'))
    try {
      await writeFile(join(external, 'meta.json'), JSON.stringify({ segments: [] }))
      await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
      await symlink(external, tantivyIndexDir(bundleRoot))
      expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-096: returns false when `derived/tantivy` is a symlink to an external directory with a valid index/meta.json', async () => {
    // Plant a fully valid external `tantivy` tree: real `index`
    // directory + plausible `meta.json`. Without intermediate
    // containment, `lstat(<bundle>/derived/tantivy/index)` would
    // observe the external `index` (intermediate symlinks resolve
    // transparently) and report it as recoverable.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-ext-mid-'))
    try {
      await mkdir(join(external, 'index'), { recursive: true })
      await writeFile(join(external, 'index', 'meta.json'), JSON.stringify({ segments: [] }))
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'tantivy'))
      expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-096: returns false when `derived` is a symlink to an external directory with a valid tantivy/index/meta.json', async () => {
    // Same shape but the symlink lands one level higher in the
    // chain. The probe must reject before walking any deeper.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-ext-derived-'))
    try {
      const externalIndex = join(external, 'tantivy', 'index')
      await mkdir(externalIndex, { recursive: true })
      await writeFile(join(externalIndex, 'meta.json'), JSON.stringify({ segments: [] }))
      await symlink(external, join(bundleRoot, 'derived'))
      expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-096: returns true when the bundle root itself is opened via a symlinked alias and the derived tree is a real directory', async () => {
    // Deployment pattern: the operator opens the bundle through a
    // symlinked alias (e.g. `/opt/prosa/current -> /opt/prosa/v123`).
    // The containment check must NOT reject this — it targets
    // symlinks *inside* the managed derived tree, not the caller's
    // root.
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-alias-'))
    try {
      // Build a real index under the real bundle root.
      await writeMeta(bundleRoot, JSON.stringify({ segments: [] }))
      // Now expose that bundle through a symlinked alias.
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      expect(await tantivyIndexDirIsValid(aliasRoot)).toBe(true)
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('CQ-094: returns false when meta.json is a symlink to a valid external file', async () => {
    // The directory is real, but meta.json is a symlink to an
    // external file whose contents would otherwise satisfy the
    // validity check. Rejected unconditionally — a future writer
    // must not silently truncate or rewrite the external target.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-ext-'))
    try {
      const externalMeta = join(external, 'meta.json')
      await writeFile(externalMeta, JSON.stringify({ segments: [] }))
      await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
      await symlink(externalMeta, tantivyMetaPath(bundleRoot))
      expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
})

describe('tantivyIndexDir / tantivyMetaPath', () => {
  it('points at `<bundleRoot>/derived/tantivy/index` for the dir', () => {
    expect(tantivyIndexDir('/tmp/bundle')).toBe('/tmp/bundle/derived/tantivy/index')
  })

  it('points at `<bundleRoot>/derived/tantivy/index/meta.json` for the meta', () => {
    expect(tantivyMetaPath('/tmp/bundle')).toBe('/tmp/bundle/derived/tantivy/index/meta.json')
  })
})
