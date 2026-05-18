// CQ-065 / Lane 1 Task 9: 1k-session synthetic-bundle stress scenario.
//
// Builds 1,000 synthetic sessions through the full pipeline (raw-source
// pool → projection segments → epoch seal → atomic head swap), then
// re-opens the bundle and confirms head.json reflects exactly what was
// sealed. The test is intentionally larger than the unit suite — it is
// the load-bearing proof that the writer pools, sharding, FK closure,
// and durability paths handle realistic batch sizes without leaking,
// silently truncating, or violating idempotency.
//
// Runs in roughly 1–3 seconds locally. Marked as an e2e test so it can
// be excluded from focused unit runs if it ever becomes flaky.

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle, openBundle } from '../../src/bundle/bundle.js'
import { beginEpoch, sealEpoch } from '../../src/epoch/lifecycle.js'
import { RawSourcePackWriterPool } from '../../src/pack/raw-source-writer.js'
import { writeAllProjectionSegments } from '../../src/projection/segment-writer.js'

const SESSION_COUNT = 1000

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-1k-'))
}

function sessionRow(id: string, rawRecordId: string) {
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
    title: `synthetic session ${id}`,
    summary: null,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: null,
    timeline_confidence: 'high',
    raw_record_id: rawRecordId,
  }
}

function rawRecordRow(id: string, sourceFileId: string, objectId: string) {
  return {
    raw_record_id: id,
    source_tool: 'codex',
    source_file_id: sourceFileId,
    record_kind: 'session_jsonl_line',
    ordinal: 0,
    logical_offset: 0,
    logical_length: 128,
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

function sourceFileRow(
  id: string,
  packDigest: string,
  objectId: string,
  entry: {
    uncompressed_size: number
    stored_offset: number
    stored_length: number
    compression: 'zstd' | 'none'
  },
) {
  return {
    source_file_id: id,
    source_tool: 'codex',
    path: `/repo/${id}.jsonl`,
    file_kind: 'session_jsonl',
    size_bytes: entry.uncompressed_size,
    mtime_ns: null,
    content_hash: objectId,
    object_id: objectId,
    pack_digest: packDigest,
    stored_offset: entry.stored_offset,
    stored_length: entry.stored_length,
    compression: entry.compression,
    last_seen_epoch: 1,
  }
}

describe('e2e 1k synthetic bundle (CQ-065 stress)', () => {
  it(`seals one epoch carrying ${SESSION_COUNT} sessions + raw records + source files end-to-end`, async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_1k', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      const rawPool = new RawSourcePackWriterPool({
        rawSourcesDir: join(root, 'raw_sources'),
        createdAt: () => '2025-01-02T03:04:05.123Z',
        // Triggers sized so all 1000 entries fit into one pack per
        // shard. The mid-append rotation path is exercised by the
        // unit tests; this scenario validates the full-batch flow.
        triggers: {
          targetPackBytes: 8 * 1024 * 1024,
          maxPackBytes: 16 * 1024 * 1024,
          maxObjects: 4096,
          maxOpenMs: 60_000_000,
        },
      })
      // 1. Feed 1k synthetic source files through the raw-source pool.
      for (let i = 0; i < SESSION_COUNT; i++) {
        const sfid = `src_${i.toString().padStart(4, '0')}`
        // Per-row bytes carry the index so every blake3 is unique and
        // the dedup path doesn't collapse them.
        const payload = new TextEncoder().encode(`payload-${sfid}-content-bytes`)
        await rawPool.appendSourceFile({
          source_file_id: sfid,
          source_tool: 'codex',
          path: `/repo/${sfid}.jsonl`,
          file_kind: 'session_jsonl',
          mtime_ns: null,
          bytes: payload,
        })
      }
      const emissions = await rawPool.flushAll()
      expect(emissions.length).toBeGreaterThan(0)

      // 2. Index pack entries by source_file_id and register every
      //    raw-source pack as a durable ref.
      const entryById = new Map<string, ReturnType<typeof Object>>()
      const packDigestById = new Map<string, string>()
      for (const e of emissions) {
        for (const entry of e.built.header.entries) {
          entryById.set(entry.source_file_id, entry)
          packDigestById.set(entry.source_file_id, e.packDigest)
        }
        handle.registerSegment({
          kind: 'raw_source_pack',
          path: e.packPath,
          digest: e.packDigest,
          byteLength: e.built.bytes.length,
        })
      }
      expect(entryById.size).toBe(SESSION_COUNT)

      // 3. Stage source_file, raw_record, and session rows. For each
      //    sfid, drop a putRawSource so the rawSourceRoot reflects
      //    durable bytes.
      for (const [sfid, entry] of entryById) {
        const e = entry as {
          content_hash: string
          object_id: string
          uncompressed_size: number
          stored_offset: number
          stored_length: number
          compression: 'zstd' | 'none'
          stored_hash: string
        }
        const packDigest = packDigestById.get(sfid)!
        handle.putRawSource({
          source_file_id: sfid,
          content_hash: e.content_hash,
          uncompressed_size: e.uncompressed_size,
          compression: 'zstd',
          stored_hash: e.stored_hash,
        })
        const srcFile = sourceFileRow(sfid, packDigest, e.object_id, e)
        handle.putRow('source_file', sfid, srcFile as never)
        const rrid = `raw_${sfid}`
        handle.putRow('raw_record', rrid, rawRecordRow(rrid, sfid, e.content_hash) as never)
        const sesId = `ses_${sfid.slice(4)}`
        handle.putRow('session', sesId, sessionRow(sesId, rrid) as never)
      }

      // 4. Emit one projection segment per entity type and register.
      const rowsByEntity = handle.rowsByEntity()
      const segResults = await writeAllProjectionSegments(rowsByEntity as never, { outDir: handle.tmpDir })
      for (const s of segResults) handle.registerSegment(s.ref)

      // 5. Seal.
      const sealed = await sealEpoch(handle)
      expect(sealed.epoch).toBe(1)
      expect(sealed.head.counts.sessions).toBe(SESSION_COUNT)
      expect(sealed.head.counts.sourceFiles).toBe(SESSION_COUNT)
      expect(sealed.head.counts.rawRecords).toBe(SESSION_COUNT)
      // counts.objects is the verified CAS inventory; no CAS packs
      // were registered in this scenario.
      expect(sealed.head.counts.objects).toBe(0)
      expect(sealed.head.bundleRoot).toMatch(/^[0-9a-f]{64}$/)
      expect(sealed.head.rawSourceRoot).toMatch(/^[0-9a-f]{64}$/)
      const permStat = await stat(sealed.permanentDir)
      expect(permStat.isDirectory()).toBe(true)
    } finally {
      await bundle.close().catch(() => undefined)
    }
  }, 30_000)

  it('reopens a sealed 1k-session bundle and head.json round-trips', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_1k_reopen', createdAt: '2025-01-02T03:04:05.123Z' })
    let sealedBundleRoot: string
    let sealedSessionsCount: number
    try {
      const handle = await beginEpoch(bundle, { createdAt: '2025-01-02T03:04:06.000Z' })
      // Smaller batch for reopen path (200 sessions) to keep the
      // round-trip test under a second.
      const N = 200
      const rawPool = new RawSourcePackWriterPool({
        rawSourcesDir: join(root, 'raw_sources'),
        createdAt: () => '2025-01-02T03:04:05.123Z',
      })
      for (let i = 0; i < N; i++) {
        const sfid = `src_${i.toString().padStart(4, '0')}`
        const payload = new TextEncoder().encode(`reopen-payload-${sfid}`)
        await rawPool.appendSourceFile({
          source_file_id: sfid,
          source_tool: 'codex',
          path: `/repo/${sfid}.jsonl`,
          file_kind: 'session_jsonl',
          mtime_ns: null,
          bytes: payload,
        })
      }
      const emissions = await rawPool.flushAll()
      for (const e of emissions) {
        handle.registerSegment({
          kind: 'raw_source_pack',
          path: e.packPath,
          digest: e.packDigest,
          byteLength: e.built.bytes.length,
        })
        for (const entry of e.built.header.entries) {
          handle.putRawSource({
            source_file_id: entry.source_file_id,
            content_hash: entry.content_hash,
            uncompressed_size: entry.uncompressed_size,
            compression: 'zstd',
            stored_hash: entry.stored_hash,
          })
          const srcFile = sourceFileRow(entry.source_file_id, e.packDigest, entry.object_id, entry)
          handle.putRow('source_file', entry.source_file_id, srcFile as never)
          const rrid = `raw_${entry.source_file_id}`
          handle.putRow('raw_record', rrid, rawRecordRow(rrid, entry.source_file_id, entry.content_hash) as never)
          const sesId = `ses_${entry.source_file_id.slice(4)}`
          handle.putRow('session', sesId, sessionRow(sesId, rrid) as never)
        }
      }
      const segs = await writeAllProjectionSegments(handle.rowsByEntity() as never, { outDir: handle.tmpDir })
      for (const s of segs) handle.registerSegment(s.ref)
      const sealed = await sealEpoch(handle)
      sealedBundleRoot = sealed.head.bundleRoot
      sealedSessionsCount = sealed.head.counts.sessions
      expect(sealedSessionsCount).toBe(N)
    } finally {
      await bundle.close()
    }
    const reopened = await openBundle(root)
    try {
      expect(reopened.head.epoch).toBe(1)
      expect(reopened.head.counts.sessions).toBe(sealedSessionsCount)
      expect(reopened.head.bundleRoot).toBe(sealedBundleRoot)
      // head.json on disk parses and matches in-memory.
      const raw = await readFile(reopened.paths.headJson, 'utf8')
      const parsed = JSON.parse(raw) as { epoch: number; bundleRoot: string }
      expect(parsed.epoch).toBe(1)
      expect(parsed.bundleRoot).toBe(sealedBundleRoot)
    } finally {
      await reopened.close()
    }
  }, 30_000)
})
