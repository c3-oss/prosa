import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initBundle, openBundle } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'

import { runCompileImports } from '../../src/orchestrator.js'
import { type CheapIdentification, type LogicalImportUnit, type Provider, emptyDraft } from '../../src/types.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-orch-'))
}

// Mock provider: emits one session per discovered file with a
// deterministic logical key + canonical raw-source payload.
function mockProvider(args: { sourceTool: 'codex' | 'claude' }): Provider {
  return {
    source_tool: args.sourceTool,
    async discover() {
      return [
        {
          source_file_id: 'src_a',
          path: '/repo/a.jsonl',
          source_tool: args.sourceTool,
          file_kind: 'session_jsonl',
          bytes: new TextEncoder().encode('payload-a'),
        },
        {
          source_file_id: 'src_b',
          path: '/repo/b.jsonl',
          source_tool: args.sourceTool,
          file_kind: 'session_jsonl',
          bytes: new TextEncoder().encode('payload-b'),
        },
      ]
    },
    async cheapIdentify(file): Promise<CheapIdentification> {
      return {
        logicalKey: new TextEncoder().encode(`${args.sourceTool}:${file.source_file_id}`),
        unit_id: `unit_${file.source_file_id}`,
        logical_kind: 'session',
      }
    },
    async parseAndProject(input) {
      const file = input.files[0]!
      const bytes = file.bytes!
      const objectId = `blake3:${Buffer.from(blake3(bytes)).toString('hex')}`
      const draft = emptyDraft()
      draft.source_files.push({
        source_file_id: file.source_file_id,
        source_tool: args.sourceTool,
        path: file.path,
        file_kind: file.file_kind,
        size_bytes: bytes.length,
        mtime_ns: null,
        content_hash: objectId,
        object_id: objectId,
        pack_digest: 'blake3:0000000000000000000000000000000000000000000000000000000000000001',
        stored_offset: 0,
        stored_length: bytes.length,
        compression: 'zstd',
        last_seen_epoch: 1,
      })
      const rawRecordId = `raw_${file.source_file_id}`
      draft.raw_records.push({
        raw_record_id: rawRecordId,
        source_tool: args.sourceTool,
        source_file_id: file.source_file_id,
        record_kind: 'session_jsonl_line',
        ordinal: 0,
        logical_offset: 0,
        logical_length: bytes.length,
        line_no: 1,
        json_pointer: null,
        parser_status: 'parsed',
        confidence: 'high',
        content_hash: objectId,
        object_id: objectId,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
      const sessionId = `ses_${file.source_file_id}`
      draft.sessions.push({
        session_id: sessionId,
        source_tool: args.sourceTool,
        source_session_id: file.source_file_id,
        project_id: null,
        parent_session_id: null,
        parent_resolution: 'unresolved',
        is_subagent: false,
        agent_role: null,
        agent_nickname: null,
        title: null,
        summary: null,
        start_ts: input.createdAt,
        end_ts: null,
        cwd_initial: null,
        git_branch_initial: null,
        model_first: null,
        model_last: null,
        status: null,
        timeline_confidence: 'high',
        raw_record_id: rawRecordId,
      })
      const unit: LogicalImportUnit = {
        unit_id: input.identification.unit_id,
        source_tool: args.sourceTool,
        logical_kind: 'session',
        source_file_ids: [file.source_file_id],
        raw_record_ids: [rawRecordId],
        raw_source_payloads: new Map([[file.source_file_id, bytes]]),
        projection: draft,
        raw_source_leaves: [
          {
            source_file_id: file.source_file_id,
            content_hash: objectId,
            uncompressed_size: bytes.length,
            compression: 'zstd',
            stored_hash: objectId,
          },
        ],
        merge: { merge_strategy: 'single_source' },
      }
      return { unit, summary: { files: 1, sessions: 1, rawRecords: 1 } }
    },
  }
}

describe('runCompileImports orchestrator', () => {
  it('seals one epoch with one mock provider', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_orch', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: mockProvider({ sourceTool: 'codex' }), root: '/anywhere' }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(result.perProvider[0]?.source_tool).toBe('codex')
      expect(result.perProvider[0]?.discovered).toBe(2)
      expect(result.perProvider[0]?.won).toBe(2)
      expect(result.perProvider[0]?.lost).toBe(0)
      expect(bundle.head.epoch).toBe(1)
      expect(bundle.head.counts.sessions).toBe(2)
      expect(bundle.head.counts.rawRecords).toBe(2)
      expect(bundle.head.counts.sourceFiles).toBe(2)
    } finally {
      await bundle.close()
    }
  })

  it('runs two providers sequentially in one epoch', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_two', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [
          { provider: mockProvider({ sourceTool: 'codex' }), root: '/c' },
          { provider: mockProvider({ sourceTool: 'claude' }), root: '/cl' },
        ],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.perProvider.length).toBe(2)
      // The mock provider uses identical source_file_ids across providers;
      // because PutIfAbsent on the 'session' shard would dedupe, we use
      // distinct ids in the row primary keys (`ses_<id>`) and the source
      // tool tag distinguishes the rows. Total sessions = 2 per provider
      // → 4 sessions across both providers but the mock uses the same
      // session_ids so they collide and only 2 land.
      expect(bundle.head.epoch).toBe(1)
      expect(bundle.head.counts.sessions).toBeGreaterThanOrEqual(2)
    } finally {
      await bundle.close()
    }
  })

  it('re-opens the bundle after a sealed compile', async () => {
    const root = await tmp()
    const bundle = await initBundle(root, { storeId: 'st_re', createdAt: '2025-01-02T03:04:05.123Z' })
    let sealedEpoch: number
    try {
      const r = await runCompileImports({
        bundle,
        providers: [{ provider: mockProvider({ sourceTool: 'codex' }), root: '/r' }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      sealedEpoch = r.sealedEpoch
    } finally {
      await bundle.close()
    }
    const reopened = await openBundle(root)
    try {
      expect(reopened.head.epoch).toBe(sealedEpoch)
    } finally {
      await reopened.close()
    }
  })
})
