import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EMPTY_BUNDLE_COUNTS, makeEmptyHead, readHead, writeHead } from '../../src/bundle/head.js'

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'prosa-bundle-v2-head-'))
}

const ROOT = `${'0'.repeat(64)}`
const TAG = `blake3:${'1'.repeat(64)}`

describe('head.json atomic read/write', () => {
  it('writes and reads back a canonical head', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'head.json')
    const head = makeEmptyHead({
      storeId: 'st_alpha',
      storePath: dir,
      parserVersion: '2.0.0-lane1',
      createdAt: '2025-01-02T03:04:05.123Z',
      bundleRoot: ROOT,
      rawSourceRoot: ROOT,
      manifestDigest: TAG,
    })
    await writeHead(path, head)
    const back = await readHead(path)
    expect(back.bundleFormat).toBe(2)
    expect(back.epoch).toBe(0)
    expect(back.bundleRoot).toBe(ROOT)
    expect(back.counts).toEqual(EMPTY_BUNDLE_COUNTS)
  })

  it('writes via temp + rename, leaving no .tmp behind', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'head.json')
    const head = makeEmptyHead({
      storeId: 'st_alpha',
      storePath: dir,
      parserVersion: '2.0.0',
      createdAt: '2025-01-02T03:04:05.123Z',
      bundleRoot: ROOT,
      rawSourceRoot: ROOT,
      manifestDigest: TAG,
    })
    await writeHead(path, head)
    const raw = await readFile(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('rejects non-v2 head content on read', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'head.json')
    await mkdir(dir, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ bundleFormat: 1 }))
    await expect(readHead(path)).rejects.toThrow(/bundleFormat/)
  })
})
