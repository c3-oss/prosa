import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle } from '../../src/bundle/bundle.js'
import { FkClosureError, beginEpoch, sealEpoch, validateFkClosure } from '../../src/epoch/lifecycle.js'

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'prosa-epoch-'))
}

const TAG = (n: number) => `blake3:${n.toString(16).padStart(64, '0')}`

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

function turnRow(id: string, sessionId: string) {
  return {
    turn_id: id,
    session_id: sessionId,
    source_turn_id: null,
    ordinal: 0,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    model: null,
    cwd: null,
    git_branch: null,
    approval_policy: null,
    sandbox_policy: null,
    effort: null,
    raw_record_id: null,
  }
}

describe('validateFkClosure', () => {
  it('passes when every reference resolves', () => {
    expect(() =>
      validateFkClosure({
        session: [sessionRow('ses_a')],
        turn: [turnRow('trn_a', 'ses_a')],
      } as never),
    ).not.toThrow()
  })

  it('throws FkClosureError when a child references a missing parent', () => {
    expect(() =>
      validateFkClosure({
        session: [sessionRow('ses_a')],
        turn: [turnRow('trn_a', 'ses_missing')],
      } as never),
    ).toThrow(FkClosureError)
  })

  it('ignores nullable references', () => {
    expect(() =>
      validateFkClosure({
        session: [sessionRow('ses_a')],
      } as never),
    ).not.toThrow()
  })
})

describe('beginEpoch + sealEpoch', () => {
  it('seals an epoch and atomically advances the head', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, {
      storeId: 'st_a',
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      handle.putRow('turn', 'trn_a', turnRow('trn_a', 'ses_a') as never)
      handle.putRawSource({
        source_file_id: 'src_a',
        content_hash: TAG(1),
        uncompressed_size: 100,
        compression: 'zstd',
        stored_hash: TAG(2),
      })
      const sealed = await sealEpoch(handle)
      expect(sealed.epoch).toBe(1)
      expect(sealed.head.epoch).toBe(1)
      expect(sealed.head.previousBundleRoot).toBe(bundle.head.previousBundleRoot ?? bundle.head.bundleRoot)
      expect(sealed.head.counts.sessions).toBe(1)
      expect(sealed.head.counts.turns).toBe(1)
      expect(sealed.head.counts.objects).toBe(1)
      // Permanent dir exists, tmp dir does not.
      const permStat = await stat(sealed.permanentDir)
      expect(permStat.isDirectory()).toBe(true)
      await expect(stat(handle.tmpDir)).rejects.toThrow()
      // head.json on disk matches.
      const raw = await readFile(bundle.paths.headJson, 'utf8')
      const head = JSON.parse(raw)
      expect(head.epoch).toBe(1)
      expect(head.bundleRoot).toBe(sealed.head.bundleRoot)
    } finally {
      await bundle.close()
    }
  })

  it('rejects sealing when FK closure fails', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, {
      storeId: 'st_a',
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      // turn references missing session.
      handle.putRow('turn', 'trn_a', turnRow('trn_a', 'ses_missing') as never)
      await expect(sealEpoch(handle)).rejects.toThrow(FkClosureError)
      // head.json must still point at epoch 0 (atomic seal failed).
      const raw = await readFile(bundle.paths.headJson, 'utf8')
      const head = JSON.parse(raw)
      expect(head.epoch).toBe(0)
    } finally {
      await bundle.close()
    }
  })

  it('refuses to seal twice from the same handle', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, {
      storeId: 'st_a',
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      await sealEpoch(handle)
      // The handle's tmpDir was renamed by the first seal; a second seal
      // will fail when it tries to mkdir/rename a missing tmp dir, OR
      // when swapHead refuses the same epoch number.
      await expect(sealEpoch(handle)).rejects.toThrow()
    } finally {
      await bundle.close()
    }
  })
})
