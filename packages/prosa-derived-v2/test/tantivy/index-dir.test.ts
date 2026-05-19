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
    // Plant a symlink whose target does not exist; `stat` follows
    // links, so this returns ENOENT and the probe must report false.
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await symlink(join(bundleRoot, 'derived', 'tantivy', 'no-such-target'), tantivyIndexDir(bundleRoot))
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
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
