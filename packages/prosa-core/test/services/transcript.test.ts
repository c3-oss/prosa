import { describe, expect, it } from 'vitest'
import { putBytes, putText } from '../../src/core/cas/index.js'
import { loadTranscript } from '../../src/services/transcript.js'
import { type TempBundle, createTempBundle } from '../helpers/tmp-bundle.js'

const NOW = '2026-05-15T00:00:00.000Z'

interface SeedHandles {
  sessionId: string
  rawRecordId: string
}

/**
 * Seed a minimal but FK-correct synthetic bundle: one source_file, one
 * import_batch, one raw_record, and one session. Returns the row ids so
 * tests can attach messages/blocks/tool calls without re-deriving FK plumbing.
 */
async function seedBundleBase(t: TempBundle): Promise<SeedHandles> {
  const rawObjectId = await putText(t.bundle, '{"seed":true}', { mimeType: 'application/json' })
  const db = t.bundle.db

  db.prepare(
    `INSERT INTO source_files (source_file_id, source_tool, path, file_kind, size_bytes, content_hash, object_id, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('sf:test', 'codex', '/tmp/seed.jsonl', 'jsonl', 13, 'deadbeef', rawObjectId, NOW)

  db.prepare(
    `INSERT INTO import_batches (batch_id, parser_version, source_tool, started_at, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('batch:test', '0.0.0-test', 'codex', NOW, 'ok')

  const rawRecordId = 'rr:test'
  db.prepare(
    `INSERT INTO raw_records (raw_record_id, source_file_id, source_tool, record_kind,
                              ordinal, raw_object_id, parser_status, import_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(rawRecordId, 'sf:test', 'codex', 'message', 0, rawObjectId, 'parsed', 'batch:test')

  const sessionId = 'sess:test'
  db.prepare(
    `INSERT INTO sessions (session_id, source_tool, source_session_id, title,
                           start_ts, end_ts, model_first, model_last, timeline_confidence, raw_record_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, 'codex', 'src-1', 'Hello transcript', NOW, NOW, 'gpt-5', 'gpt-5', 'high', rawRecordId)

  return { sessionId, rawRecordId }
}

function insertMessage(
  t: TempBundle,
  args: { id: string; sessionId: string; role: string; ordinal: number; model?: string | null; rawRecordId: string },
): void {
  t.bundle.db
    .prepare(
      `INSERT INTO messages (message_id, session_id, role, ordinal, model, raw_record_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(args.id, args.sessionId, args.role, args.ordinal, args.model ?? null, args.rawRecordId)
}

function insertBlock(
  t: TempBundle,
  args: {
    blockId: string
    sessionId: string
    messageId: string | null
    ordinal: number
    blockType: string
    textInline?: string | null
    textObjectId?: string | null
    visibility?: 'default' | 'hidden_by_default' | 'audit_only'
    rawRecordId: string
  },
): void {
  t.bundle.db
    .prepare(
      `INSERT INTO content_blocks (block_id, message_id, session_id, ordinal, block_type,
                                   text_object_id, text_inline, visibility, raw_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.blockId,
      args.messageId,
      args.sessionId,
      args.ordinal,
      args.blockType,
      args.textObjectId ?? null,
      args.textInline ?? null,
      args.visibility ?? 'default',
      args.rawRecordId,
    )
}

function insertToolCall(
  t: TempBundle,
  args: {
    toolCallId: string
    sessionId: string
    messageId: string | null
    toolName: string
    rawRecordId: string
    timestampStart?: string | null
  },
): void {
  t.bundle.db
    .prepare(
      `INSERT INTO tool_calls (tool_call_id, session_id, message_id, tool_name,
                               timestamp_start, raw_record_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(args.toolCallId, args.sessionId, args.messageId, args.toolName, args.timestampStart ?? null, args.rawRecordId)
}

function insertToolResult(
  t: TempBundle,
  args: {
    toolResultId: string
    toolCallId: string
    sessionId: string
    preview?: string | null
    rawRecordId: string
  },
): void {
  t.bundle.db
    .prepare(
      `INSERT INTO tool_results (tool_result_id, tool_call_id, session_id, preview, raw_record_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(args.toolResultId, args.toolCallId, args.sessionId, args.preview ?? null, args.rawRecordId)
}

describe('loadTranscript', () => {
  it('returns null when the session is absent', async () => {
    const t = await createTempBundle()
    try {
      const result = await loadTranscript(t.bundle, 'sess:does-not-exist')
      expect(result).toBeNull()
    } finally {
      await t.cleanup()
    }
  })

  it('assembles user + assistant turns with matched tool call+result', async () => {
    const t = await createTempBundle()
    try {
      const { sessionId, rawRecordId } = await seedBundleBase(t)
      insertMessage(t, { id: 'm1', sessionId, role: 'user', ordinal: 0, rawRecordId })
      insertMessage(t, { id: 'm2', sessionId, role: 'assistant', ordinal: 1, model: 'gpt-5', rawRecordId })
      insertBlock(t, {
        blockId: 'b1',
        sessionId,
        messageId: 'm1',
        ordinal: 0,
        blockType: 'text',
        textInline: 'hi assistant',
        rawRecordId,
      })
      insertBlock(t, {
        blockId: 'b2',
        sessionId,
        messageId: 'm2',
        ordinal: 0,
        blockType: 'text',
        textInline: 'hello user',
        rawRecordId,
      })
      insertToolCall(t, {
        toolCallId: 'tc1',
        sessionId,
        messageId: 'm2',
        toolName: 'bash',
        timestampStart: NOW,
        rawRecordId,
      })
      insertToolResult(t, {
        toolResultId: 'tr1',
        toolCallId: 'tc1',
        sessionId,
        preview: 'ok',
        rawRecordId,
      })

      const result = await loadTranscript(t.bundle, sessionId)
      expect(result).not.toBeNull()
      expect(result?.turns).toHaveLength(2)
      expect(result?.turns[0]?.role).toBe('user')
      expect(result?.turns[0]?.blocks[0]?.text).toBe('hi assistant')
      expect(result?.turns[1]?.role).toBe('assistant')
      expect(result?.turns[1]?.toolCalls).toHaveLength(1)
      const call = result?.turns[1]?.toolCalls[0]
      expect(call?.toolName).toBe('bash')
      expect(call?.result?.preview).toBe('ok')
      expect(result?.unattachedToolCalls).toEqual([])
    } finally {
      await t.cleanup()
    }
  })

  it('keeps hidden_by_default blocks with hidden=true', async () => {
    const t = await createTempBundle()
    try {
      const { sessionId, rawRecordId } = await seedBundleBase(t)
      insertMessage(t, { id: 'm1', sessionId, role: 'assistant', ordinal: 0, rawRecordId })
      insertBlock(t, {
        blockId: 'b1',
        sessionId,
        messageId: 'm1',
        ordinal: 0,
        blockType: 'thinking',
        textInline: 'reasoning step',
        visibility: 'hidden_by_default',
        rawRecordId,
      })

      const result = await loadTranscript(t.bundle, sessionId)
      expect(result?.turns[0]?.blocks).toHaveLength(1)
      const block = result?.turns[0]?.blocks[0]
      expect(block?.hidden).toBe(true)
      expect(block?.text).toBe('reasoning step')
    } finally {
      await t.cleanup()
    }
  })

  it('resolves text_object_id when ≤ maxInlineBytes', async () => {
    const t = await createTempBundle()
    try {
      const { sessionId, rawRecordId } = await seedBundleBase(t)
      const objectId = await putText(t.bundle, 'cas-text-body')
      insertMessage(t, { id: 'm1', sessionId, role: 'assistant', ordinal: 0, rawRecordId })
      insertBlock(t, {
        blockId: 'b1',
        sessionId,
        messageId: 'm1',
        ordinal: 0,
        blockType: 'text',
        textObjectId: objectId,
        rawRecordId,
      })

      const result = await loadTranscript(t.bundle, sessionId)
      const block = result?.turns[0]?.blocks[0]
      expect(block?.text).toBe('cas-text-body')
      expect(block?.textObjectId).toBe(objectId)
    } finally {
      await t.cleanup()
    }
  })

  it('returns null text but keeps textObjectId when CAS body > maxInlineBytes', async () => {
    const t = await createTempBundle()
    try {
      const { sessionId, rawRecordId } = await seedBundleBase(t)
      // 2 KB body; with a 256-byte limit it must NOT be inlined.
      const big = 'x'.repeat(2048)
      const objectId = await putBytes(t.bundle, Buffer.from(big, 'utf8'), {
        mimeType: 'text/plain; charset=utf-8',
        encoding: 'utf-8',
      })
      insertMessage(t, { id: 'm1', sessionId, role: 'assistant', ordinal: 0, rawRecordId })
      insertBlock(t, {
        blockId: 'b1',
        sessionId,
        messageId: 'm1',
        ordinal: 0,
        blockType: 'text',
        textObjectId: objectId,
        rawRecordId,
      })

      const result = await loadTranscript(t.bundle, sessionId, { maxInlineBytes: 256 })
      const block = result?.turns[0]?.blocks[0]
      expect(block?.text).toBeNull()
      expect(block?.textObjectId).toBe(objectId)
    } finally {
      await t.cleanup()
    }
  })

  it('places tool_calls with NULL message_id into unattachedToolCalls', async () => {
    const t = await createTempBundle()
    try {
      const { sessionId, rawRecordId } = await seedBundleBase(t)
      insertToolCall(t, {
        toolCallId: 'tc-orphan',
        sessionId,
        messageId: null,
        toolName: 'bash',
        timestampStart: NOW,
        rawRecordId,
      })

      const result = await loadTranscript(t.bundle, sessionId)
      expect(result?.turns).toHaveLength(0)
      expect(result?.unattachedToolCalls).toHaveLength(1)
      expect(result?.unattachedToolCalls[0]?.toolCallId).toBe('tc-orphan')
    } finally {
      await t.cleanup()
    }
  })
})
