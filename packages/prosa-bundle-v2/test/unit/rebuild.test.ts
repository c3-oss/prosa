import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle } from '../../src/bundle/bundle.js'
import { beginEpoch, sealEpoch } from '../../src/epoch/lifecycle.js'
import { writeProjectionSegment } from '../../src/projection/segment-writer.js'
import { RebuildIntegrityError, rebuildIndex } from '../../src/rebuild/index.js'
import { MemoryShardActor } from '../../src/shard/memory-actor.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-rebuild-'))
}

function sessionRow(id: string) {
  return {
    session_id: id,
    source_tool: 'codex',
    source_session_id: `src_${id}`,
    project_id: null,
    parent_session_id: null,
    parent_resolution: 'unresolved',
    is_subagent: false,
    agent_role: null,
    agent_nickname: null,
    title: null,
    summary: null,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: null,
    timeline_confidence: 'high',
    raw_record_id: null,
  }
}

describe('rebuildIndex', () => {
  it('reconstructs per-shard logs from sealed epoch projection segments', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_rebuild', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      const sessions = ['ses_a', 'ses_b', 'ses_c', 'ses_d', 'ses_e', 'ses_f']
      for (const id of sessions) handle.putRow('session', id, sessionRow(id) as never)
      const seg = await writeProjectionSegment('session', sessions.map(sessionRow) as never, {
        outDir: handle.tmpDir,
      })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)

      const result = await rebuildIndex(bundle, { uuid: 'test1' })
      // A fresh bundle has head epoch 0 but no `epochs/0/` directory —
      // only sealed epochs leave dirs. After one seal we expect epoch 1.
      expect(result.manifest.epochsWalked).toEqual([1])
      expect(result.manifest.totalRowsByKeyspace.session).toBe(sessions.length)
      expect(result.manifest.perShardCounts.reduce((a, b) => a + b, 0)).toBe(sessions.length)
      // Each shard file exists, even if empty.
      const files = await readdir(bundle.paths.index)
      const logs = files.filter((f) => f.endsWith('.log'))
      expect(logs.length).toBe(4)
      // rebuild.manifest also present.
      expect(files).toContain('rebuild.manifest')
    } finally {
      await bundle.close()
    }
  })

  it('archives the previous index dir on rebuild', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_archive', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await rebuildIndex(bundle, { uuid: 'test2' })
      expect(result.archivedAt).toMatch(/index-old-/)
      const archivedStat = await stat(result.archivedAt!)
      expect(archivedStat.isDirectory()).toBe(true)
    } finally {
      await bundle.close()
    }
  })

  it('produced shard logs are loadable by MemoryShardActor.openPersistent', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_replay', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, {
        outDir: handle.tmpDir,
      })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      await rebuildIndex(bundle, { uuid: 'test3' })

      // Open every shard log and confirm at least one entry survives the replay.
      let totalEntries = 0
      for (let i = 0; i < 4; i++) {
        const path = join(bundle.paths.index, `shard-${String(i).padStart(2, '0')}.log`)
        const actor = await MemoryShardActor.openPersistent(i, path)
        const snap = await actor.snapshot()
        for (const [, kv] of snap.entries) totalEntries += kv.size
        await actor.close()
      }
      expect(totalEntries).toBe(1)
    } finally {
      await bundle.close()
    }
  })

  it('handles an empty bundle (no sealed epochs beyond init)', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_empty', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await rebuildIndex(bundle, { uuid: 'test4' })
      // An init-only bundle has no sealed epoch dirs.
      expect(result.manifest.epochsWalked).toEqual([])
      expect(result.manifest.totalRowsByKeyspace).toEqual({})
    } finally {
      await bundle.close()
    }
  })

  it('rebuild.manifest carries storeId, uuid, and per-shard counts', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_meta', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const r = await rebuildIndex(bundle, { uuid: 'meta1' })
      const raw = await readFile(join(bundle.paths.index, 'rebuild.manifest'), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.storeId).toBe('st_meta')
      expect(parsed.uuid).toBe('meta1')
      expect(parsed.shardCount).toBe(4)
      expect(parsed.perShardCounts.length).toBe(4)
      // Suppress unused variable lints.
      expect(typeof r.manifest.rebuiltAt).toBe('string')
    } finally {
      await bundle.close()
    }
  })

  it('CQ-046: rejects a tampered signed manifest (segment digest rewrite)', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_tamper', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Tamper the signed manifest to declare a fake segment digest
      // while leaving epoch.manifest.json (unsigned) untouched. The
      // dual-file cross-check must fire.
      const signedPath = join(bundle.paths.root, 'epochs', '1', 'epoch.manifest.signed.json')
      const raw = JSON.parse(await readFile(signedPath, 'utf8'))
      raw.manifest.segments[0].digest = 'blake3:0000000000000000000000000000000000000000000000000000000000000001'
      await writeFile(signedPath, `${JSON.stringify(raw, null, 2)}\n`)
      await expect(rebuildIndex(bundle, { uuid: 'tamper1' })).rejects.toThrow(RebuildIntegrityError)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-046: rejects an extra projection segment not declared in the manifest', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_extra', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Drop an extra projection file into the sealed epoch's
      // projection dir; rebuild must refuse.
      const extra = join(bundle.paths.root, 'epochs', '1', 'projection', 'project.prosa-projection.ndjson')
      await writeFile(
        extra,
        new TextEncoder().encode(
          '{"bundleFormat":2,"segmentKind":"projection_ndjson","entityType":"project","rowCount":0}\n',
        ),
      )
      await expect(rebuildIndex(bundle, { uuid: 'extra1' })).rejects.toThrow(RebuildIntegrityError)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-046: rejects when manifest declares a projection segment missing from disk', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_miss', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      const segPath = join(bundle.paths.root, 'epochs', '1', 'projection', 'session.prosa-projection.ndjson')
      const { rm } = await import('node:fs/promises')
      await rm(segPath)
      await expect(rebuildIndex(bundle, { uuid: 'miss1' })).rejects.toThrow(RebuildIntegrityError)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-050: rejects a tampered unsigned manifest (head.json digest pin)', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_unsigned_tamper', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Tamper epoch.manifest.json + the signed manifest body in
      // lockstep so the dual-file equality check still passes; the
      // head.json.manifestDigest pin must fire.
      const unsignedPath = join(bundle.paths.root, 'epochs', '1', 'epoch.manifest.json')
      const signedPath = join(bundle.paths.root, 'epochs', '1', 'epoch.manifest.signed.json')
      const unsigned = JSON.parse(await readFile(unsignedPath, 'utf8'))
      unsigned.segments[0].digest = 'blake3:0000000000000000000000000000000000000000000000000000000000000002'
      const canon = (v: unknown): string => {
        if (v === null) return 'null'
        if (typeof v === 'boolean') return v ? 'true' : 'false'
        if (typeof v === 'number') return String(v)
        if (typeof v === 'string') return JSON.stringify(v)
        if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
        if (typeof v === 'object') {
          const o = v as Record<string, unknown>
          const ks = Object.keys(o).sort()
          return `{${ks.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`
        }
        throw new Error('canon: unsupported')
      }
      await writeFile(unsignedPath, canon(unsigned))
      const signed = JSON.parse(await readFile(signedPath, 'utf8'))
      signed.manifest = unsigned
      await writeFile(signedPath, `${JSON.stringify(signed, null, 2)}\n`)
      await expect(rebuildIndex(bundle, { uuid: 'unsigned1' })).rejects.toThrow(/manifestDigest/)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-050: rejects when head.json.manifestDigest is missing for the current head epoch', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_strip_digest', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      const headPath = bundle.paths.headJson
      await bundle.close()
      const head = JSON.parse(await readFile(headPath, 'utf8'))
      head.manifestDigest = ''
      await writeFile(headPath, `${JSON.stringify(head, null, 2)}\n`)
      const { openBundle } = await import('../../src/bundle/bundle.js')
      const reopened = await openBundle(root)
      try {
        await expect(rebuildIndex(reopened, { uuid: 'stripdigest1' })).rejects.toThrow(
          /manifestDigest is missing or empty/,
        )
      } finally {
        await reopened.close()
      }
    } catch (e) {
      await bundle.close().catch(() => undefined)
      throw e
    }
  })

  it('CQ-053: rejects rebuild when head.epoch > 0 but the head epoch directory is missing', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_no_epoch_dir', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Remove the entire epochs/1 dir while head.json still points at
      // epoch 1. Rebuild must refuse rather than silently install an
      // empty index that bypasses every per-epoch integrity check.
      const { rm } = await import('node:fs/promises')
      await rm(join(bundle.paths.root, 'epochs', '1'), { recursive: true, force: true })
      await expect(rebuildIndex(bundle, { uuid: 'no_epoch1' })).rejects.toThrow(/CQ-053/)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-053: rejects rebuild when manifest declares projection segments but projection/ is missing', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_no_proj_dir', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      const { rm } = await import('node:fs/promises')
      await rm(join(bundle.paths.root, 'epochs', '1', 'projection'), { recursive: true, force: true })
      await expect(rebuildIndex(bundle, { uuid: 'no_proj1' })).rejects.toThrow(/CQ-053/)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-056: rejects rebuild when an epoch directory greater than head.epoch is present', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_stray_epoch', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // head.epoch is 1; create a stray epochs/2 directory.
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(bundle.paths.root, 'epochs', '2'), { recursive: true })
      await expect(rebuildIndex(bundle, { uuid: 'stray1' })).rejects.toThrow(/CQ-056/)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-056: rejects rebuild when a non-contiguous epoch directory below head is missing', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_gap_epoch', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      // Seal epoch 1 then epoch 2.
      const h1 = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      h1.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const s1 = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: h1.tmpDir })
      h1.registerSegment(s1.ref)
      await sealEpoch(h1)
      const h2 = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:07.000Z' })
      h2.putRow('session', 'ses_b', sessionRow('ses_b') as never)
      const s2 = await writeProjectionSegment('session', [sessionRow('ses_b')] as never, { outDir: h2.tmpDir })
      h2.registerSegment(s2.ref)
      await sealEpoch(h2)
      // Delete epochs/1 to create a gap; head.epoch is still 2.
      const { rm } = await import('node:fs/promises')
      await rm(join(bundle.paths.root, 'epochs', '1'), { recursive: true, force: true })
      await expect(rebuildIndex(bundle, { uuid: 'gap1' })).rejects.toThrow(/CQ-056|CQ-053/)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-060: rejects lockstep tamper of a non-head epoch projection + manifest pair', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_chain_tamper', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      // Seal two epochs.
      const h1 = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      h1.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const s1 = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: h1.tmpDir })
      h1.registerSegment(s1.ref)
      await sealEpoch(h1)
      const h2 = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:07.000Z' })
      h2.putRow('session', 'ses_b', sessionRow('ses_b') as never)
      const s2 = await writeProjectionSegment('session', [sessionRow('ses_b')] as never, { outDir: h2.tmpDir })
      h2.registerSegment(s2.ref)
      await sealEpoch(h2)

      // Baseline rebuild should succeed.
      await rebuildIndex(bundle, { uuid: 'baseline_chain' })

      // Tamper epoch 1: replace session.ses_a's payload, recompute the
      // segment digest, and rewrite BOTH unsigned + signed manifests in
      // lockstep so the dual-file equality check passes. head.json is
      // unchanged. Without CQ-060's chain anchor, rebuild would silently
      // install the tampered row.
      const e1Dir = join(bundle.paths.root, 'epochs', '1')
      const segPath = join(e1Dir, 'projection', 'session.prosa-projection.ndjson')
      const unsignedPath = join(e1Dir, 'epoch.manifest.json')
      const signedPath = join(e1Dir, 'epoch.manifest.signed.json')
      const tamperedRow = { ...sessionRow('ses_a'), title: 'TAMPERED' }
      // Rewrite the segment via writeProjectionSegment to produce a
      // legitimate-shape file with a different digest.
      const scratch = await mkdtemp(join(tmpdir(), 'prosa-tamper-'))
      const rewritten = await writeProjectionSegment('session', [tamperedRow] as never, { outDir: scratch })
      const { readFile: rf2, writeFile: wf, rm: rm2 } = await import('node:fs/promises')
      const newSegBytes = await rf2(rewritten.ref.path)
      await wf(segPath, newSegBytes)
      // Patch both manifests to declare the new segment digest, then
      // canonical-re-encode both so the dual-file equality check passes.
      const unsigned = JSON.parse(await rf2(unsignedPath, 'utf8')) as {
        segments: Array<Record<string, unknown>>
        bundleRoot: string
      }
      unsigned.segments[0]!.digest = rewritten.ref.digest
      // A coherent lockstep tamper updates the manifest's bundleRoot
      // to match the new content. With the original bundleRoot kept,
      // the manifest would be internally inconsistent; updating it
      // makes the dual-file check pass — and then the CQ-060 chain
      // anchor catches the mismatch against head epoch 2's
      // previousBundleRoot.
      unsigned.bundleRoot = `${'0'.repeat(63)}1`
      const canon = (v: unknown): string => {
        if (v === null) return 'null'
        if (typeof v === 'boolean') return v ? 'true' : 'false'
        if (typeof v === 'number') return String(v)
        if (typeof v === 'string') return JSON.stringify(v)
        if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
        if (typeof v === 'object') {
          const o = v as Record<string, unknown>
          const ks = Object.keys(o).sort()
          return `{${ks.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`
        }
        throw new Error('canon: unsupported')
      }
      await wf(unsignedPath, canon(unsigned))
      const signed = JSON.parse(await rf2(signedPath, 'utf8')) as { manifest: unknown }
      signed.manifest = unsigned
      await wf(signedPath, `${JSON.stringify(signed, null, 2)}\n`)
      await rm2(scratch, { recursive: true, force: true })

      // Capture pre-rebuild index state.
      const { readdir } = await import('node:fs/promises')
      const indexBefore = await readdir(bundle.paths.index)
      indexBefore.sort()
      const headBefore = await rf2(bundle.paths.headJson, 'utf8')
      // Rebuild must refuse — head epoch 2's manifest declares
      // previousBundleRoot = epoch 1's original bundleRoot, but
      // epoch 1's manifest now carries a different bundleRoot.
      await expect(rebuildIndex(bundle, { uuid: 'chain_tamper1' })).rejects.toThrow(/CQ-060/)
      // index/ and head.json unchanged.
      const indexAfter = await readdir(bundle.paths.index)
      indexAfter.sort()
      expect(indexAfter).toEqual(indexBefore)
      expect(await rf2(bundle.paths.headJson, 'utf8')).toBe(headBefore)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-057: failed rebuild does not replace or archive existing index/', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_atomic_fail', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // First rebuild to install a recognizable index/ marker file.
      await rebuildIndex(bundle, { uuid: 'baseline' })
      const { mkdir, readdir, readFile } = await import('node:fs/promises')
      const indexBefore = await readdir(bundle.paths.index)
      indexBefore.sort()
      const baselineManifest = await readFile(join(bundle.paths.index, 'rebuild.manifest'), 'utf8')
      const headBefore = await readFile(bundle.paths.headJson, 'utf8')
      const rootBefore = await readdir(bundle.paths.root)
      const oldIndexBefore = rootBefore.filter((n) => n.startsWith('index-old-')).sort()
      // Now break the bundle so the next rebuild fails: add a stray epoch
      // directory greater than head.epoch.
      await mkdir(join(bundle.paths.root, 'epochs', '99'), { recursive: true })
      await expect(rebuildIndex(bundle, { uuid: 'fail1' })).rejects.toThrow(/CQ-056/)
      const indexAfter = await readdir(bundle.paths.index)
      indexAfter.sort()
      const headAfter = await readFile(bundle.paths.headJson, 'utf8')
      const manifestAfter = await readFile(join(bundle.paths.index, 'rebuild.manifest'), 'utf8')
      const rootAfter = await readdir(bundle.paths.root)
      const oldIndexAfter = rootAfter.filter((n) => n.startsWith('index-old-')).sort()
      // Existing index/ contents unchanged.
      expect(indexAfter).toEqual(indexBefore)
      // rebuild.manifest body is the same baseline (failed rebuild
      // never overwrote it).
      expect(manifestAfter).toBe(baselineManifest)
      // head.json untouched.
      expect(headAfter).toBe(headBefore)
      // No new index-old-* archive directory.
      expect(oldIndexAfter).toEqual(oldIndexBefore)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-061: install rename failure rolls archive back to index/', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_install_fail', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Baseline rebuild to install a recognizable index/.
      await rebuildIndex(bundle, { uuid: 'baseline_install' })
      const { readdir, readFile: rf3 } = await import('node:fs/promises')
      const indexBefore = await readdir(bundle.paths.index)
      indexBefore.sort()
      const baselineManifest = await rf3(join(bundle.paths.index, 'rebuild.manifest'), 'utf8')
      const rootBefore = await readdir(bundle.paths.root)
      const archivesBefore = rootBefore.filter((n) => n.startsWith('index-old-')).sort()

      // Inject a fault into the install rename: the first call
      // (archive) succeeds, the second (scratch→index) throws.
      const fsp = await import('node:fs/promises')
      let calls = 0
      await expect(
        rebuildIndex(bundle, {
          uuid: 'install_fail1',
          _renameImpl: async (from, to) => {
            calls++
            if (calls === 2) throw new Error('simulated EIO during install rename')
            await fsp.rename(from, to)
          },
        }),
      ).rejects.toThrow(/CQ-061/)
      // The archive rollback should have restored index/. Confirm
      // index/ is intact and no index-old-* remains.
      const indexAfter = await readdir(bundle.paths.index)
      indexAfter.sort()
      expect(indexAfter).toEqual(indexBefore)
      const manifestAfter = await rf3(join(bundle.paths.index, 'rebuild.manifest'), 'utf8')
      expect(manifestAfter).toBe(baselineManifest)
      // No NEW archive directory created by the failed install
      // (rollback returned the archive contents to `index/`).
      const rootAfter = await readdir(bundle.paths.root)
      const archivesAfter = rootAfter.filter((n) => n.startsWith('index-old-')).sort()
      expect(archivesAfter).toEqual(archivesBefore)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-061: when rollback also fails, throws RebuildInstallError with archivedAt set and rolledBack=false', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_install_double_fail', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      await rebuildIndex(bundle, { uuid: 'baseline_double' })
      const { readdir } = await import('node:fs/promises')
      const rootBefore = await readdir(bundle.paths.root)
      const archivesBefore = rootBefore.filter((n) => n.startsWith('index-old-')).sort()

      const fsp = await import('node:fs/promises')
      let calls = 0
      // Fail both call 2 (install) AND call 3 (rollback). Call 1
      // (archive) still succeeds so the bundle ends up with the old
      // index sitting in `index-old-*` and no active `index/`.
      const renameImpl = async (from: string, to: string): Promise<void> => {
        calls++
        if (calls === 2) throw new Error('simulated install rename EIO')
        if (calls === 3) throw new Error('simulated rollback rename EIO')
        await fsp.rename(from, to)
      }
      let captured: unknown
      try {
        await rebuildIndex(bundle, { uuid: 'install_double_fail1', _renameImpl: renameImpl })
      } catch (e) {
        captured = e
      }
      const { RebuildInstallError } = await import('../../src/rebuild/index.js')
      expect(captured).toBeInstanceOf(RebuildInstallError)
      const err = captured as InstanceType<typeof RebuildInstallError>
      expect(err.rolledBack).toBe(false)
      expect(err.archivedAt).toMatch(/index-old-/)
      // Stat the carried archive path to confirm it really exists.
      const { stat: statFn } = await import('node:fs/promises')
      const archiveStat = await statFn(err.archivedAt as string)
      expect(archiveStat.isDirectory()).toBe(true)
      // A NEW archive directory now exists (the one CQ-061 abandoned).
      const rootAfter = await readdir(bundle.paths.root)
      const archivesAfter = rootAfter.filter((n) => n.startsWith('index-old-')).sort()
      expect(archivesAfter.length).toBe(archivesBefore.length + 1)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-046: rejects a missing manifest pair (no silent skip)', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_missing', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Remove the signed manifest; rebuild must refuse rather than
      // silently skip digest checks for this epoch.
      const { rm } = await import('node:fs/promises')
      await rm(join(bundle.paths.root, 'epochs', '1', 'epoch.manifest.signed.json'))
      await expect(rebuildIndex(bundle, { uuid: 'missing1' })).rejects.toThrow(RebuildIntegrityError)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-043: rejects a drifted projection segment (digest mismatch vs manifest)', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_drift', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
      // Tamper with the sealed projection file post-seal.
      const segPath = join(bundle.paths.root, 'epochs', '1', 'projection', 'session.prosa-projection.ndjson')
      const raw = await readFile(segPath)
      const tampered = new Uint8Array(raw)
      tampered[tampered.length - 2] = (tampered[tampered.length - 2] as number) ^ 0xff
      await writeFile(segPath, tampered)
      await expect(rebuildIndex(bundle, { uuid: 'drift1' })).rejects.toThrow(RebuildIntegrityError)
    } finally {
      await bundle.close()
    }
  })

  it('does not affect head.json or sealed epoch dirs', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_stable', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const before = await readFile(bundle.paths.headJson, 'utf8')
      await rebuildIndex(bundle, { uuid: 'stable1' })
      const after = await readFile(bundle.paths.headJson, 'utf8')
      expect(after).toBe(before)
    } finally {
      await bundle.close()
    }
  })
})
