// Tests for `summariseDerivedLayerFootprint`.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { summariseDerivedLayerFootprint } from '../src/footprint.js'

describe('summariseDerivedLayerFootprint', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-footprint-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns the all-zero shape for a bundle with no derived tree at all', async () => {
    const footprint = await summariseDerivedLayerFootprint(bundleRoot)
    expect(footprint).toEqual({
      total_bytes: 0,
      session_blob: { byte_count: 0, file_count: 0, present: false },
      tantivy: { byte_count: 0, file_count: 0, present: false },
      analytics: { byte_count: 0, file_count: 0, present: false },
      other: { byte_count: 0, file_count: 0, present: false },
    })
  })

  it('returns all-zero with present: false subsystems when derived/ exists but is empty', async () => {
    await mkdir(join(bundleRoot, 'derived'), { recursive: true })
    const footprint = await summariseDerivedLayerFootprint(bundleRoot)
    expect(footprint.total_bytes).toBe(0)
    expect(footprint.session_blob.present).toBe(false)
    expect(footprint.tantivy.present).toBe(false)
    expect(footprint.analytics.present).toBe(false)
    expect(footprint.other.present).toBe(false)
  })

  it('counts session-blob packs across multiple epochs', async () => {
    await mkdir(join(bundleRoot, 'derived', 'session-blob', 'epoch-1'), { recursive: true })
    await mkdir(join(bundleRoot, 'derived', 'session-blob', 'epoch-2'), { recursive: true })
    await writeFile(join(bundleRoot, 'derived', 'session-blob', 'epoch-1', 'alpha.pack'), Buffer.alloc(1024))
    await writeFile(join(bundleRoot, 'derived', 'session-blob', 'epoch-1', 'bravo.pack'), Buffer.alloc(2048))
    await writeFile(join(bundleRoot, 'derived', 'session-blob', 'epoch-2', 'alpha.pack'), Buffer.alloc(4096))

    const footprint = await summariseDerivedLayerFootprint(bundleRoot)
    expect(footprint.session_blob).toEqual({ byte_count: 7168, file_count: 3, present: true })
    expect(footprint.tantivy.present).toBe(false)
    expect(footprint.total_bytes).toBe(7168)
  })

  it('counts tantivy index files (recursive: meta.json + index/ + checkpoint.json)', async () => {
    await mkdir(join(bundleRoot, 'derived', 'tantivy', 'index'), { recursive: true })
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'checkpoint.json'), 'x'.repeat(100))
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'index', 'meta.json'), 'y'.repeat(50))
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'index', 'segment-0.idx'), Buffer.alloc(8192))

    const footprint = await summariseDerivedLayerFootprint(bundleRoot)
    expect(footprint.tantivy).toEqual({ byte_count: 100 + 50 + 8192, file_count: 3, present: true })
    expect(footprint.session_blob.present).toBe(false)
    expect(footprint.total_bytes).toBe(100 + 50 + 8192)
  })

  it('aggregates all three subsystems + an unknown subdirectory into `total_bytes` and `other`', async () => {
    await mkdir(join(bundleRoot, 'derived', 'session-blob'), { recursive: true })
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await mkdir(join(bundleRoot, 'derived', 'analytics'), { recursive: true })
    await mkdir(join(bundleRoot, 'derived', 'experimental-new-thing'), { recursive: true })
    await writeFile(join(bundleRoot, 'derived', 'session-blob', 'a.pack'), Buffer.alloc(100))
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'b.idx'), Buffer.alloc(200))
    await writeFile(join(bundleRoot, 'derived', 'analytics', 'c.duckdb'), Buffer.alloc(400))
    await writeFile(join(bundleRoot, 'derived', 'experimental-new-thing', 'd.bin'), Buffer.alloc(800))

    const footprint = await summariseDerivedLayerFootprint(bundleRoot)
    expect(footprint.session_blob.byte_count).toBe(100)
    expect(footprint.tantivy.byte_count).toBe(200)
    expect(footprint.analytics.byte_count).toBe(400)
    expect(footprint.other).toEqual({ byte_count: 800, file_count: 1, present: true })
    expect(footprint.total_bytes).toBe(100 + 200 + 400 + 800)
  })

  it('refuses to follow a symlink at the subsystem root (CQ-094 parallel containment)', async () => {
    const offBundleTarget = await mkdtemp(join(tmpdir(), 'prosa-footprint-target-'))
    await writeFile(join(offBundleTarget, 'leaked.pack'), Buffer.alloc(1024))
    try {
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(offBundleTarget, join(bundleRoot, 'derived', 'session-blob'), 'dir')
      await expect(summariseDerivedLayerFootprint(bundleRoot)).rejects.toThrow(/CQ-094 parallel/)
    } finally {
      await rm(offBundleTarget, { recursive: true, force: true })
    }
  })

  it('refuses to follow a symlink at an intermediate directory inside a subsystem', async () => {
    const offBundleTarget = await mkdtemp(join(tmpdir(), 'prosa-footprint-target-'))
    await writeFile(join(offBundleTarget, 'leaked.pack'), Buffer.alloc(1024))
    try {
      await mkdir(join(bundleRoot, 'derived', 'session-blob'), { recursive: true })
      await symlink(offBundleTarget, join(bundleRoot, 'derived', 'session-blob', 'epoch-9'), 'dir')
      await expect(summariseDerivedLayerFootprint(bundleRoot)).rejects.toThrow(/refusing to follow symlink/)
    } finally {
      await rm(offBundleTarget, { recursive: true, force: true })
    }
  })

  it('refuses to follow a symlink at the derived/ root itself', async () => {
    const offBundleTarget = await mkdtemp(join(tmpdir(), 'prosa-footprint-target-'))
    try {
      await symlink(offBundleTarget, join(bundleRoot, 'derived'), 'dir')
      await expect(summariseDerivedLayerFootprint(bundleRoot)).rejects.toThrow(/CQ-094 parallel/)
    } finally {
      await rm(offBundleTarget, { recursive: true, force: true })
    }
  })
})
