// CQ-065 / Lane 1 Task 8 / Task 9: cold-rebuild end-to-end.
//
// Seals a multi-session epoch, deletes the on-disk `index/`, runs
// `rebuildIndex`, and verifies (a) the rebuilt shards contain the
// expected per-keyspace row counts, (b) re-opening the bundle works
// against the rebuilt index, and (c) running rebuildIndex a second
// time is idempotent (head.json + bundleRoot unchanged, archive set
// grows by exactly one).

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle, openBundle } from '../../src/bundle/bundle.js'
import { beginEpoch, sealEpoch } from '../../src/epoch/lifecycle.js'
import { writeProjectionSegment } from '../../src/projection/segment-writer.js'
import { rebuildIndex } from '../../src/rebuild/index.js'
import { MemoryShardActor } from '../../src/shard/memory-actor.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-cold-rebuild-'))
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
    title: `cold-rebuild session ${id}`,
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

describe('e2e cold rebuild (CQ-065 task 8 / CQ-066)', () => {
  it('CQ-066: real CLI cold rebuild — spawns `prosa bundle rebuild-index --store <path>` and verifies shard contents', async () => {
    const root = await tmp()
    const ids = Array.from({ length: 16 }, (_, i) => `ses_cli_${i.toString().padStart(3, '0')}`)
    const bundle = await initBundle(root, { storeId: 'st_cli_cold', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      for (const id of ids) handle.putRow('session', id, sessionRow(id) as never)
      const seg = await writeProjectionSegment('session', ids.map(sessionRow) as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
    } finally {
      await bundle.close()
    }

    // Delete index/ and rebuild via the real CLI subprocess.
    await rm(join(root, 'index'), { recursive: true, force: true })

    const { spawnSync } = await import('node:child_process')
    // Resolve `prosa` CLI via the workspace's dev runner so we
    // don't depend on a built dist.
    const cliEntry = join(__dirname, '..', '..', '..', '..', 'apps', 'cli', 'src', 'bin', 'prosa.ts')
    const result = spawnSync(
      'node',
      [
        '--conditions=prosa-dev',
        '--import',
        '@swc-node/register/esm-register',
        cliEntry,
        'bundle',
        'rebuild-index',
        '--store',
        root,
        '--uuid',
        'cli-e2e-1',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    if (result.status !== 0) {
      throw new Error(`prosa CLI exited ${result.status}: ${result.stderr}`)
    }
    // The command writes a manifest JSON blob to stdout; parse and
    // assert it covers epoch 1 with the sealed sessions.
    const manifest = JSON.parse(result.stdout) as {
      epochsWalked: number[]
      totalRowsByKeyspace: Record<string, number>
      uuid: string
      newIndexDir: string
    }
    expect(manifest.uuid).toBe('cli-e2e-1')
    expect(manifest.epochsWalked).toEqual([1])
    expect(manifest.totalRowsByKeyspace.session).toBe(ids.length)
    // Re-open the bundle and replay every shard log via the
    // MemoryShardActor, confirming each id is recoverable.
    const reopened = await openBundle(root)
    try {
      const recovered = new Set<string>()
      for (let i = 0; i < 4; i++) {
        const path = join(reopened.paths.index, `shard-${String(i).padStart(2, '0')}.log`)
        const actor = await MemoryShardActor.openPersistent(i, path)
        const snap = await actor.snapshot()
        for (const [, kv] of snap.entries) {
          for (const [keyHex] of kv) {
            recovered.add(Buffer.from(keyHex, 'hex').toString('utf8'))
          }
        }
        await actor.close()
      }
      for (const id of ids) expect(recovered.has(id)).toBe(true)
    } finally {
      await reopened.close()
    }
  }, 60_000)

  it('reconstructs per-shard logs after `index/` is deleted, and replay matches sealed rows', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_cold', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      const sessions = Array.from({ length: 32 }, (_, i) => `ses_${i.toString().padStart(3, '0')}`)
      for (const id of sessions) handle.putRow('session', id, sessionRow(id) as never)
      const seg = await writeProjectionSegment('session', sessions.map(sessionRow) as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)

      // Wipe index/ entirely; reapStaleTmp + rebuildIndex must
      // reconstruct it.
      await rm(bundle.paths.index, { recursive: true, force: true })
      const result = await rebuildIndex(bundle, { uuid: 'cold-rebuild-1' })
      expect(result.manifest.epochsWalked).toEqual([1])
      expect(result.manifest.totalRowsByKeyspace.session).toBe(sessions.length)
      expect(result.manifest.perShardCounts.reduce((a, b) => a + b, 0)).toBe(sessions.length)

      // Replay every shard log through MemoryShardActor and confirm
      // every session id is recoverable.
      const recovered = new Set<string>()
      for (let i = 0; i < 4; i++) {
        const path = join(bundle.paths.index, `shard-${String(i).padStart(2, '0')}.log`)
        const actor = await MemoryShardActor.openPersistent(i, path)
        const snap = await actor.snapshot()
        for (const [, kv] of snap.entries) {
          for (const [keyHex] of kv) {
            // Decode hex → utf-8 to get the original session id.
            const buf = Buffer.from(keyHex, 'hex')
            recovered.add(buf.toString('utf8'))
          }
        }
        await actor.close()
      }
      for (const id of sessions) expect(recovered.has(id)).toBe(true)
    } finally {
      await bundle.close()
    }
  })

  it('idempotent rebuild: re-opening bundle + rebuilding twice leaves head.json unchanged', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_cold_idem', createdAt: '2025-01-02T03:04:05.123Z' })
    let sealedBundleRoot: string
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      const sealed = await sealEpoch(handle)
      sealedBundleRoot = sealed.head.bundleRoot

      const headBefore = await readFile(bundle.paths.headJson, 'utf8')
      await rebuildIndex(bundle, { uuid: 'cold-rebuild-idem-1' })
      const headAfter1 = await readFile(bundle.paths.headJson, 'utf8')
      expect(headAfter1).toBe(headBefore)
      const rootMid = await readdir(bundle.paths.root)
      const archivesMid = rootMid.filter((n) => n.startsWith('index-old-')).length

      // Second rebuild should also succeed, with one additional
      // `index-old-*` archive.
      await rebuildIndex(bundle, { uuid: 'cold-rebuild-idem-2' })
      const headAfter2 = await readFile(bundle.paths.headJson, 'utf8')
      expect(headAfter2).toBe(headBefore)
      const rootEnd = await readdir(bundle.paths.root)
      const archivesEnd = rootEnd.filter((n) => n.startsWith('index-old-')).length
      expect(archivesEnd).toBe(archivesMid + 1)
    } finally {
      await bundle.close()
    }

    // Re-open the bundle and confirm head.json still reflects the
    // sealed epoch unchanged.
    const reopened = await openBundle(root)
    try {
      expect(reopened.head.epoch).toBe(1)
      expect(reopened.head.bundleRoot).toBe(sealedBundleRoot)
      const indexStat = await stat(reopened.paths.index)
      expect(indexStat.isDirectory()).toBe(true)
    } finally {
      await reopened.close()
    }
  })
})
