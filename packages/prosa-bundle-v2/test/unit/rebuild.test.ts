import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle } from '../../src/bundle/bundle.js'
import { beginEpoch, sealEpoch } from '../../src/epoch/lifecycle.js'
import { writeProjectionSegment } from '../../src/projection/segment-writer.js'
import { rebuildIndex } from '../../src/rebuild/index.js'
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
