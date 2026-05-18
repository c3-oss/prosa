import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle } from '../../src/bundle/bundle.js'
import {
  DurabilityError,
  FkClosureError,
  beginEpoch,
  reapStaleTmp,
  sealEpoch,
  validateFkClosure,
} from '../../src/epoch/lifecycle.js'

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
      // CQ-023: register durable refs that back the rows.
      handle.registerSegment({
        kind: 'projection_arrow',
        path: 'epochs/1/projection/sessions.arrow',
        digest: `blake3:${'a'.repeat(64)}`,
        byteLength: 1,
        entityType: 'session',
      })
      handle.registerSegment({
        kind: 'projection_arrow',
        path: 'epochs/1/projection/turns.arrow',
        digest: `blake3:${'b'.repeat(64)}`,
        byteLength: 1,
        entityType: 'turn',
      })
      handle.registerSegment({
        kind: 'raw_source_pack',
        path: 'raw_sources/packs/p.pack',
        digest: `blake3:${'c'.repeat(64)}`,
        byteLength: 1,
        objectIds: [TAG(1)],
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
      handle.registerSegment({
        kind: 'projection_arrow',
        path: 'p',
        digest: `blake3:${'a'.repeat(64)}`,
        byteLength: 1,
        entityType: 'session',
      })
      await sealEpoch(handle)
      // The handle's tmpDir was renamed by the first seal; a second seal
      // will fail when it tries to rename a missing tmp dir, OR when
      // swapHead refuses the same epoch number.
      await expect(sealEpoch(handle)).rejects.toThrow()
    } finally {
      await bundle.close()
    }
  })

  it('seals an empty epoch without durable refs (CQ-023)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      const sealed = await sealEpoch(handle)
      expect(sealed.epoch).toBe(1)
      expect(sealed.head.counts.projectionRows).toBe(0)
    } finally {
      await bundle.close()
    }
  })

  it('rejects sealing rows without a registered projection segment (CQ-023)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      await expect(sealEpoch(handle)).rejects.toThrow(DurabilityError)
    } finally {
      await bundle.close()
    }
  })

  it('rejects sealing raw_source entries without a raw_source_pack (CQ-023)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRawSource({
        source_file_id: 'src_a',
        content_hash: TAG(1),
        uncompressed_size: 100,
        compression: 'zstd',
        stored_hash: TAG(2),
      })
      await expect(sealEpoch(handle)).rejects.toThrow(DurabilityError)
    } finally {
      await bundle.close()
    }
  })

  it('rejects projection rows referencing object_ids missing from the inventory (CQ-024)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      // An artifact row referencing an object_id that the inventory does
      // not contain.
      handle.putRow('artifact', 'art_a', {
        artifact_id: 'art_a',
        session_id: null,
        project_id: null,
        source_tool: 'codex',
        kind: 'file',
        path: null,
        logical_path: null,
        object_id: TAG(9),
        text_object_id: null,
        mime_type: null,
        size_bytes: 0,
        created_ts: '2025-01-02T03:04:05.123Z',
        raw_record_id: null,
      } as never)
      handle.registerSegment({
        kind: 'projection_arrow',
        path: 'p',
        digest: `blake3:${'a'.repeat(64)}`,
        byteLength: 1,
        entityType: 'artifact',
      })
      await expect(sealEpoch(handle)).rejects.toThrow(FkClosureError)
    } finally {
      await bundle.close()
    }
  })

  it('reapStaleTmp drops leftover tmp/epoch-N from a crashed sealer (CQ-025)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      // Simulate a crashed sealer: create tmp/epoch-7/somefile.
      const { mkdir, writeFile, readdir } = await import('node:fs/promises')
      const { join } = await import('node:path')
      await mkdir(join(bundle.paths.tmp, 'epoch-7'), { recursive: true })
      await writeFile(join(bundle.paths.tmp, 'epoch-7', 'orphan.tmp'), 'x')
      const reaped = await reapStaleTmp(bundle)
      expect(reaped.some((p) => p.endsWith('epoch-7'))).toBe(true)
      const after = await readdir(bundle.paths.tmp).catch(() => [] as string[])
      expect(after.some((e) => e.startsWith('epoch-'))).toBe(false)
    } finally {
      await bundle.close()
    }
  })
})
