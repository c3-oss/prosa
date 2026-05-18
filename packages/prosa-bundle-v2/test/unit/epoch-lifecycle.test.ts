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
import { RawSourcePackWriterPool } from '../../src/pack/raw-source-writer.js'
import { writeProjectionSegment } from '../../src/projection/segment-writer.js'

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

  it('CQ-032: artifact.object_id resolves only against CAS inventory, not raw-source', () => {
    expect(() =>
      validateFkClosure(
        {
          artifact: [
            {
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
            },
          ],
        } as never,
        { rawSourceInventory: new Set([TAG(9)]) }, // present in raw-source — must still fail.
      ),
    ).toThrow(FkClosureError)
  })

  it('CQ-033: rejects a session whose parent_session_id is missing', () => {
    const a = sessionRow('ses_a')
    const b = { ...sessionRow('ses_b'), parent_session_id: 'ses_missing' }
    expect(() => validateFkClosure({ session: [a, b] } as never)).toThrow(/parent_session_id/)
  })

  it('CQ-033: rejects a search_doc whose entity_id is not in the named entity_type', () => {
    expect(() =>
      validateFkClosure({
        session: [sessionRow('ses_a')],
        search_doc: [
          {
            doc_id: 'sdc_a',
            entity_type: 'session',
            entity_id: 'ses_missing',
            session_id: null,
            project_id: null,
            timestamp: null,
            role: null,
            tool_name: null,
            canonical_tool_type: null,
            field_kind: 'message_text',
            errors_only: false,
            text: '',
          },
        ],
      } as never),
    ).toThrow(/search_doc/)
  })
})

describe('beginEpoch + sealEpoch', () => {
  async function makeRawSourcePack(bundle: { paths: { root: string } }, sourceFileId: string, bytes: Uint8Array) {
    const pool = new RawSourcePackWriterPool({
      rawSourcesDir: join(bundle.paths.root, 'raw_sources'),
      createdAt: () => '2025-01-02T03:04:05.123Z',
    })
    await pool.appendSourceFile({
      source_file_id: sourceFileId,
      source_tool: 'codex',
      path: `/repo/${sourceFileId}.jsonl`,
      file_kind: 'session_jsonl',
      mtime_ns: null,
      bytes,
    })
    const [emission] = await pool.flushAll()
    if (!emission) throw new Error('expected pack emission')
    return emission
  }

  it('seals an epoch and atomically advances the head with verified durable refs', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      handle.putRow('turn', 'trn_a', turnRow('trn_a', 'ses_a') as never)
      // Real raw-source pack on disk.
      const pack = await makeRawSourcePack(bundle, 'src_a', new TextEncoder().encode('payload'))
      const objectId = pack.built.header.entries[0]!.content_hash
      handle.putRawSource({
        source_file_id: 'src_a',
        content_hash: objectId,
        uncompressed_size: pack.built.header.entries[0]!.uncompressed_size,
        compression: 'zstd',
        stored_hash: pack.built.header.entries[0]!.stored_hash,
      })
      handle.registerSegment({
        kind: 'raw_source_pack',
        path: pack.packPath,
        digest: pack.packDigest,
        byteLength: pack.built.bytes.length,
      })
      // Real projection segments.
      const sessSeg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      const turnSeg = await writeProjectionSegment('turn', [turnRow('trn_a', 'ses_a')] as never, {
        outDir: handle.tmpDir,
      })
      handle.registerSegment(sessSeg.ref)
      handle.registerSegment(turnSeg.ref)

      const sealed = await sealEpoch(handle)
      expect(sealed.epoch).toBe(1)
      expect(sealed.head.counts.sessions).toBe(1)
      expect(sealed.head.counts.turns).toBe(1)
      expect(sealed.head.counts.objects).toBe(1)
      const permStat = await stat(sealed.permanentDir)
      expect(permStat.isDirectory()).toBe(true)
      await expect(stat(handle.tmpDir)).rejects.toThrow()
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
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('turn', 'trn_a', turnRow('trn_a', 'ses_missing') as never)
      const seg = await writeProjectionSegment('turn', [turnRow('trn_a', 'ses_missing')] as never, {
        outDir: handle.tmpDir,
      })
      handle.registerSegment(seg.ref)
      await expect(sealEpoch(handle)).rejects.toThrow(FkClosureError)
      const raw = await readFile(bundle.paths.headJson, 'utf8')
      const head = JSON.parse(raw)
      expect(head.epoch).toBe(0)
    } finally {
      await bundle.close()
    }
  })

  it('refuses to seal twice from the same handle', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      const seg = await writeProjectionSegment('session', [sessionRow('ses_a')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await sealEpoch(handle)
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

  it('rejects projection rows referencing object_ids missing from the CAS inventory (CQ-024 + CQ-032)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      const artifactRow = {
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
      }
      handle.putRow('artifact', 'art_a', artifactRow as never)
      const seg = await writeProjectionSegment('artifact', [artifactRow] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await expect(sealEpoch(handle)).rejects.toThrow(FkClosureError)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-031: rejects a forged ref whose path does not exist', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.registerSegment({
        kind: 'raw_source_pack',
        path: join(bundle.paths.root, 'nope.pack'),
        digest: TAG(1),
        byteLength: 100,
      })
      await expect(sealEpoch(handle)).rejects.toThrow(DurabilityError)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-031: rejects a ref whose path is outside the bundle root', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.registerSegment({
        kind: 'projection_arrow',
        path: '/tmp/outside-bundle.pack',
        digest: TAG(1),
        byteLength: 1,
        entityType: 'session',
      })
      await expect(sealEpoch(handle)).rejects.toThrow(/outside the bundle root/)
    } finally {
      await bundle.close()
    }
  })

  it('CQ-031: rejects a projection segment that does not match the in-memory rows', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      handle.putRow('session', 'ses_a', sessionRow('ses_a') as never)
      // Write a segment for *different* rows than what's in the handle.
      const seg = await writeProjectionSegment('session', [sessionRow('ses_b')] as never, { outDir: handle.tmpDir })
      handle.registerSegment(seg.ref)
      await expect(sealEpoch(handle)).rejects.toThrow(/does not match in-memory rows/)
    } finally {
      await bundle.close()
    }
  })

  it('reapStaleTmp drops leftover tmp/epoch-N from a crashed sealer (CQ-025)', async () => {
    const root = await tmpDir()
    const bundle = await initBundle(root, { storeId: 'st_a', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const { mkdir, writeFile, readdir } = await import('node:fs/promises')
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
