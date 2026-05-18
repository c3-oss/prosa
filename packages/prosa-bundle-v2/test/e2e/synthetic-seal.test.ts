// End-to-end synthetic seal: stream a small synthetic dataset through
// the CAS writer pool, raw-source writer pool, and projection segment
// writer, register every durable ref on the EpochHandle, and seal.
//
// This is the minimum e2e for Lane 1 — the lane doc names a 1000-session
// scenario, which is the next iteration's scope.

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle, openBundle } from '../../src/bundle/bundle.js'
import { beginEpoch, sealEpoch } from '../../src/epoch/lifecycle.js'
import { RawSourcePackWriterPool } from '../../src/pack/raw-source-writer.js'
import { writeProjectionSegment } from '../../src/projection/segment-writer.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-e2e-seal-'))
}

const created = () => '2025-01-02T03:04:05.123Z'
const enc = new TextEncoder()

function sessionRow(id: string, rawRecord: string) {
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
    title: `session ${id}`,
    summary: null,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: null,
    timeline_confidence: 'high',
    raw_record_id: rawRecord,
  }
}

function rawRecordRow(id: string, srcFile: string, objectId: string) {
  return {
    raw_record_id: id,
    source_tool: 'codex',
    source_file_id: srcFile,
    record_kind: 'session_jsonl_line',
    ordinal: 0,
    logical_offset: 0,
    logical_length: 256,
    line_no: 1,
    json_pointer: null,
    parser_status: 'parsed',
    confidence: 'high',
    content_hash: objectId,
    object_id: objectId,
    decoded_object_id: null,
    created_at: '2025-01-02T03:04:05.123Z',
  }
}

function sourceFileRow(id: string, packDigest: string, objectId: string) {
  return {
    source_file_id: id,
    source_tool: 'codex',
    path: `/repo/${id}.jsonl`,
    file_kind: 'session_jsonl',
    size_bytes: 32,
    mtime_ns: null,
    content_hash: objectId,
    object_id: objectId,
    pack_digest: packDigest,
    stored_offset: 0,
    stored_length: 32,
    compression: 'zstd',
    last_seen_epoch: 1,
  }
}

describe('e2e synthetic seal', () => {
  it('seals one epoch end-to-end and re-opens the bundle', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_e2e', createdAt: created() })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })

      // 1. Write the raw bytes for two source files via the raw-source pool.
      const rawPool = new RawSourcePackWriterPool({
        rawSourcesDir: join(root, 'raw_sources'),
        createdAt: created,
        triggers: { targetPackBytes: 64, maxPackBytes: 4096, maxObjects: 100, maxOpenMs: 60_000 },
      })
      const srcA = enc.encode('alpha-source-bytes-12345678')
      const srcB = enc.encode('beta-source-bytes-87654321')
      await rawPool.appendSourceFile({
        source_file_id: 'src_a',
        source_tool: 'codex',
        path: '/repo/src_a.jsonl',
        file_kind: 'session_jsonl',
        mtime_ns: null,
        bytes: srcA,
      })
      await rawPool.appendSourceFile({
        source_file_id: 'src_b',
        source_tool: 'codex',
        path: '/repo/src_b.jsonl',
        file_kind: 'session_jsonl',
        mtime_ns: null,
        bytes: srcB,
      })
      const rawEmissions = await rawPool.flushAll()
      expect(rawEmissions.length).toBeGreaterThan(0)
      // Register raw-source packs as durable + take the object IDs.
      const rawObjectIds: string[] = []
      for (const e of rawEmissions) {
        for (const entry of e.built.header.entries) {
          rawObjectIds.push(entry.object_id)
        }
        handle.registerSegment({
          kind: 'raw_source_pack',
          path: e.packPath,
          digest: e.packDigest,
          byteLength: e.built.bytes.length,
          objectIds: e.built.header.entries.map((x) => x.object_id),
        })
      }

      // 2. The raw-source content hashes also act as projection
      // `*_object_id` references; populate sessions / raw_records /
      // source_files / raw-source-entries that point at them.
      const srcAObjectId = rawEmissions
        .flatMap((e) => e.built.header.entries)
        .find((x) => x.source_file_id === 'src_a')!.object_id
      const srcBObjectId = rawEmissions
        .flatMap((e) => e.built.header.entries)
        .find((x) => x.source_file_id === 'src_b')!.object_id
      const packAForA = rawEmissions.find((e) =>
        e.built.header.entries.some((x) => x.source_file_id === 'src_a'),
      )!.packDigest
      const packAForB = rawEmissions.find((e) =>
        e.built.header.entries.some((x) => x.source_file_id === 'src_b'),
      )!.packDigest

      handle.putRow('source_file', 'src_a', sourceFileRow('src_a', packAForA, srcAObjectId) as never)
      handle.putRow('source_file', 'src_b', sourceFileRow('src_b', packAForB, srcBObjectId) as never)
      handle.putRow('raw_record', 'raw_a', rawRecordRow('raw_a', 'src_a', srcAObjectId) as never)
      handle.putRow('raw_record', 'raw_b', rawRecordRow('raw_b', 'src_b', srcBObjectId) as never)
      handle.putRow('session', 'ses_a', sessionRow('ses_a', 'raw_a') as never)
      handle.putRow('session', 'ses_b', sessionRow('ses_b', 'raw_b') as never)

      // 3. Also drop raw-source leaf inputs onto the handle so the
      // rawSourceRoot computation includes them.
      for (const e of rawEmissions) {
        for (const entry of e.built.header.entries) {
          handle.putRawSource({
            source_file_id: entry.source_file_id,
            content_hash: entry.content_hash,
            uncompressed_size: entry.uncompressed_size,
            compression: entry.compression,
            stored_hash: entry.stored_hash,
          })
        }
      }

      // 4. Emit projection segments for every entity that has rows.
      const rowsByEntity = handle.rowsByEntity()
      for (const [entity, rows] of Object.entries(rowsByEntity)) {
        if (!rows.length) continue
        const r = await writeProjectionSegment(entity as never, rows as never, { outDir: handle.tmpDir })
        handle.registerSegment(r.ref)
      }

      // 5. Seal. The durability checks should accept because:
      //    - every entity with rows now has a projection_* segment registered;
      //    - raw_source entries are backed by raw_source_pack registrations;
      //    - every *_object_id in projection rows points at a real raw_obj.
      const sealed = await sealEpoch(handle)
      expect(sealed.epoch).toBe(1)
      expect(sealed.head.counts.sessions).toBe(2)
      expect(sealed.head.counts.rawRecords).toBe(2)
      expect(sealed.head.counts.sourceFiles).toBe(2)
      expect(sealed.head.counts.objects).toBe(2)
      expect(sealed.head.counts.projectionRows).toBe(6)
      // CQ-026: pack writers exist, head includes them via segments[].
      expect(sealed.head.segments.length).toBeGreaterThan(0)
      // Permanent dir is on disk.
      expect((await stat(sealed.permanentDir)).isDirectory()).toBe(true)

      // 6. Re-open the bundle and assert it loads the new head.
      await bundle.close()
      const reopened = await openBundle(root)
      try {
        expect(reopened.head.epoch).toBe(1)
        expect(reopened.head.counts.sessions).toBe(2)
        // head.json on disk parses.
        const raw = await readFile(reopened.paths.headJson, 'utf8')
        const parsed = JSON.parse(raw)
        expect(parsed.epoch).toBe(1)
        expect(parsed.bundleRoot).toBe(sealed.head.bundleRoot)
      } finally {
        await reopened.close()
      }
    } finally {
      // bundle may already be closed by the re-open path.
      await bundle.close().catch(() => undefined)
    }
  })
})
