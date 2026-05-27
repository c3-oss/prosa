import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle, openBundle } from '../../src/bundle/bundle.js'
import { BundleLockedError } from '../../src/bundle/lock.js'

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'prosa-bundle-v2-init-'))
}

describe('initBundle + openBundle', () => {
  it('initializes an empty bundle with epoch 0', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a' })
    try {
      expect(bundle.head.epoch).toBe(0)
      expect(bundle.head.storeId).toBe('st_a')
      expect(bundle.head.bundleRoot).toMatch(/^[0-9a-f]{64}$/)
      expect(bundle.head.rawSourceRoot).toBe('0'.repeat(64))
      expect(bundle.head.manifestDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
      // Directory tree exists.
      expect((await stat(bundle.paths.epochs)).isDirectory()).toBe(true)
      expect((await stat(bundle.paths.casPacks)).isDirectory()).toBe(true)
      expect((await stat(bundle.paths.rawSourcePacks)).isDirectory()).toBe(true)
    } finally {
      await bundle.close()
    }
  })

  it('openBundle reads the head and acquires the lock', async () => {
    const root = await tmpDir()
    const init = await initBundle(root, { storeId: 'st_a' })
    await init.close()
    const opened = await openBundle(root)
    try {
      expect(opened.head.epoch).toBe(0)
      expect(opened.head.storeId).toBe('st_a')
    } finally {
      await opened.close()
    }
  })

  it('openBundle blocks a second writer with BundleLockedError', async () => {
    const root = await tmpDir()
    const a = await initBundle(root, { storeId: 'st_a' })
    await expect(openBundle(root)).rejects.toBeInstanceOf(BundleLockedError)
    await a.close()
  })

  it('openBundle with readOnly skips the lock', async () => {
    const root = await tmpDir()
    const a = await initBundle(root, { storeId: 'st_a' })
    const r = await openBundle(root, { readOnly: true })
    expect(r.head.storeId).toBe('st_a')
    await r.close()
    await a.close()
  })

  it('openBundle fails when head.json is missing', async () => {
    const root = await tmpDir()
    await expect(openBundle(root)).rejects.toThrow(/head\.json/)
  })

  it('swapHead refuses to skip epochs or revert', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a' })
    try {
      const broken = {
        ...bundle.head,
        epoch: 5,
        previousBundleRoot: bundle.head.bundleRoot,
      }
      await expect(bundle.swapHead(broken)).rejects.toThrow(/monotonically/)
    } finally {
      await bundle.close()
    }
  })
})
