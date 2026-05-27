// SessionBlobPackV2 projection-to-input bridge tests.

import type { ContentBlockV2, MessageV2, ToolCallV2 } from '@c3-oss/prosa-types-v2'
import { describe, expect, it } from 'vitest'

import { projectionToSessionBlobInputs } from '../../src/session-blob/projection-bridge.js'
import { identityCompressor } from '../../src/session-blob/reader.js'
import { writeSessionBlobPack } from '../../src/session-blob/writer.js'

function mkMessage(
  overrides: Partial<MessageV2> & Pick<MessageV2, 'message_id' | 'session_id' | 'ordinal'>,
): MessageV2 {
  const defaults: MessageV2 = {
    message_id: overrides.message_id,
    session_id: overrides.session_id,
    turn_id: null,
    event_id: null,
    source_message_id: null,
    role: 'user',
    author_name: null,
    model: null,
    timestamp: null,
    ordinal: overrides.ordinal,
    parent_message_id: null,
    request_id: null,
    status: null,
    raw_record_id: 'raw_test',
  }
  return { ...defaults, ...overrides }
}

function mkBlock(
  overrides: Partial<ContentBlockV2> & Pick<ContentBlockV2, 'block_id' | 'message_id' | 'session_id' | 'ordinal'>,
): ContentBlockV2 {
  const defaults: ContentBlockV2 = {
    block_id: overrides.block_id,
    message_id: overrides.message_id,
    event_id: null,
    session_id: overrides.session_id,
    ordinal: overrides.ordinal,
    block_type: 'text',
    text_object_id: null,
    text_inline: null,
    mime_type: null,
    token_count: null,
    is_error: false,
    is_redacted: false,
    visibility: 'default',
    raw_record_id: 'raw_test',
  }
  return { ...defaults, ...overrides }
}

describe('projectionToSessionBlobInputs', () => {
  it('orders messages by ordinal and groups blocks under their owning message', () => {
    const session_id = 'ses_a'
    const messages: MessageV2[] = [
      mkMessage({ message_id: 'msg_b', session_id, ordinal: 1, role: 'assistant' }),
      mkMessage({ message_id: 'msg_a', session_id, ordinal: 0, role: 'user' }),
    ]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({ block_id: 'blk_b1', message_id: 'msg_b', session_id, ordinal: 1, text_inline: 'second' }),
      mkBlock({ block_id: 'blk_b0', message_id: 'msg_b', session_id, ordinal: 0, text_inline: 'first' }),
      mkBlock({ block_id: 'blk_a0', message_id: 'msg_a', session_id, ordinal: 0, text_inline: 'hi' }),
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    expect(result.map((m) => m.message_id)).toEqual(['msg_a', 'msg_b'])
    expect(result[1]!.blocks.map((b) => b.block_id)).toEqual(['blk_b0', 'blk_b1'])
  })

  it('filters out rows from a different session', () => {
    const session_id = 'ses_keep'
    const messages: MessageV2[] = [
      mkMessage({ message_id: 'm_keep', session_id, ordinal: 0 }),
      mkMessage({ message_id: 'm_drop', session_id: 'ses_drop', ordinal: 0 }),
    ]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({ block_id: 'b_keep', message_id: 'm_keep', session_id, ordinal: 0, text_inline: 'kept' }),
      mkBlock({ block_id: 'b_drop', message_id: 'm_drop', session_id: 'ses_drop', ordinal: 0, text_inline: 'gone' }),
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    expect(result.map((m) => m.message_id)).toEqual(['m_keep'])
    expect(result[0]!.blocks.map((b) => b.block_id)).toEqual(['b_keep'])
  })

  it('emits inline bodies with the UTF-8 byte length', () => {
    const session_id = 'ses_inline'
    const messages: MessageV2[] = [mkMessage({ message_id: 'm', session_id, ordinal: 0 })]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({ block_id: 'b', message_id: 'm', session_id, ordinal: 0, text_inline: 'héllo' }),
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    const body = result[0]!.blocks[0]!.body
    expect(body.kind).toBe('inline')
    if (body.kind === 'inline') {
      expect(body.text).toBe('héllo')
      // 'h' (1) + 'é' (2) + 'l' (1) + 'l' (1) + 'o' (1) = 6 bytes.
      expect(body.byte_length).toBe(6)
    }
  })

  it('emits cas_ref bodies when text_object_id is set, with inline text becoming a bounded preview', () => {
    const session_id = 'ses_cas'
    const messages: MessageV2[] = [mkMessage({ message_id: 'm', session_id, ordinal: 0 })]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({
        block_id: 'b',
        message_id: 'm',
        session_id,
        ordinal: 0,
        text_inline: 'first 4096 bytes preview',
        text_object_id: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
        mime_type: 'text/plain',
      }),
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    const body = result[0]!.blocks[0]!.body
    expect(body.kind).toBe('cas_ref')
    if (body.kind === 'cas_ref') {
      expect(body.object_id).toBe('blake3:0000000000000000000000000000000000000000000000000000000000000000')
      expect(body.preview).toBe('first 4096 bytes preview')
      expect(body.mime_type).toBe('text/plain')
    }
  })

  it('emits empty inline body when neither text_inline nor text_object_id is set', () => {
    const session_id = 'ses_empty'
    const messages: MessageV2[] = [mkMessage({ message_id: 'm', session_id, ordinal: 0 })]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({ block_id: 'b', message_id: 'm', session_id, ordinal: 0, block_type: 'image' }),
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    const body = result[0]!.blocks[0]!.body
    expect(body.kind).toBe('inline')
    if (body.kind === 'inline') {
      expect(body.text).toBe('')
      expect(body.byte_length).toBe(0)
    }
  })

  it('flags tool_use blocks whose owning message is referenced by a ToolCallV2 row', () => {
    const session_id = 'ses_tool'
    const messages: MessageV2[] = [mkMessage({ message_id: 'm', session_id, ordinal: 0, role: 'assistant' })]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({
        block_id: 'b_text',
        message_id: 'm',
        session_id,
        ordinal: 0,
        block_type: 'text',
        text_inline: 'I will',
      }),
      mkBlock({ block_id: 'b_call', message_id: 'm', session_id, ordinal: 1, block_type: 'tool_use' }),
    ]
    const tool_calls: ToolCallV2[] = [
      {
        tool_call_id: 'tcl_x',
        session_id,
        turn_id: null,
        message_id: 'm',
        event_id: null,
        source_call_id: 'c_x',
        tool_name: 'bash',
        canonical_tool_type: 'shell',
        args_object_id: null,
        command: 'ls',
        cwd: null,
        path: null,
        query: null,
        timestamp_start: null,
        timestamp_end: null,
        status: 'started',
        raw_record_id: 'raw_test',
      },
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks, tool_calls })
    const blocks = result[0]!.blocks
    expect(blocks.find((b) => b.block_id === 'b_text')!.is_tool_call).toBeUndefined()
    expect(blocks.find((b) => b.block_id === 'b_call')!.is_tool_call).toBe(true)
  })

  it('CQ-091: cas_ref preview is truncated by UTF-8 byte length, not String.length', async () => {
    const { CAS_REF_PREVIEW_MAX_BYTES } = await import('../../src/session-blob/types.js')
    const session_id = 'ses_multibyte'
    const longEmoji = '😀'.repeat(4096) // 4 UTF-8 bytes each → 16384 bytes
    const messages: MessageV2[] = [mkMessage({ message_id: 'm', session_id, ordinal: 0 })]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({
        block_id: 'b',
        message_id: 'm',
        session_id,
        ordinal: 0,
        text_inline: longEmoji,
        text_object_id: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ]
    const result = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    const body = result[0]!.blocks[0]!.body
    expect(body.kind).toBe('cas_ref')
    if (body.kind === 'cas_ref') {
      const previewBytes = new TextEncoder().encode(body.preview).length
      expect(previewBytes).toBeLessThanOrEqual(CAS_REF_PREVIEW_MAX_BYTES)
      // Preview must be a complete-code-point prefix — no surrogate split.
      expect(body.preview).toBe('😀'.repeat(Math.floor(CAS_REF_PREVIEW_MAX_BYTES / 4)))
      // `byte_length` reported by the bridge must match the truncated preview's UTF-8 length.
      expect(body.byte_length).toBe(previewBytes)
    }
  })

  it('CQ-091: many multibyte cas_ref previews never produce a page above MAX_PAGE_UNCOMPRESSED_BYTES', async () => {
    const { MAX_PAGE_UNCOMPRESSED_BYTES } = await import('../../src/session-blob/types.js')
    const session_id = 'ses_multibyte_pages'
    // 128 messages, each with a cas_ref block whose preview is 4096
    // emoji code points = ~16 KiB UTF-8 each. After CQ-091 the bridge
    // caps the preview at 4 KiB UTF-8, so the page payload stays at
    // or below the 1 MiB cap.
    const messages: MessageV2[] = Array.from({ length: 128 }, (_, i) =>
      mkMessage({ message_id: `m_${i.toString().padStart(3, '0')}`, session_id, ordinal: i }),
    )
    const content_blocks: ContentBlockV2[] = messages.map((m, i) =>
      mkBlock({
        block_id: `b_${i.toString().padStart(3, '0')}`,
        message_id: m.message_id,
        session_id,
        ordinal: 0,
        text_inline: '😀'.repeat(4096),
        text_object_id: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    )
    const inputs = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    const result = writeSessionBlobPack({ session_id, epoch: 1, messages: inputs }, identityCompressor)
    for (const page of result.header.pages) {
      expect(page.uncompressed_length).toBeLessThanOrEqual(MAX_PAGE_UNCOMPRESSED_BYTES)
    }
  })

  it('round-trips through the writer end-to-end with the identity compressor', () => {
    const session_id = 'ses_roundtrip'
    const messages: MessageV2[] = [
      mkMessage({ message_id: 'm0', session_id, ordinal: 0, role: 'user', timestamp: '2026-05-19T00:00:00.000Z' }),
      mkMessage({
        message_id: 'm1',
        session_id,
        ordinal: 1,
        role: 'assistant',
        timestamp: '2026-05-19T00:00:01.000Z',
      }),
    ]
    const content_blocks: ContentBlockV2[] = [
      mkBlock({ block_id: 'b0_0', message_id: 'm0', session_id, ordinal: 0, text_inline: 'hi' }),
      mkBlock({ block_id: 'b1_0', message_id: 'm1', session_id, ordinal: 0, text_inline: 'hello' }),
      mkBlock({
        block_id: 'b1_1',
        message_id: 'm1',
        session_id,
        ordinal: 1,
        block_type: 'thinking',
        text_inline: 'reasoning',
        visibility: 'hidden_by_default',
      }),
    ]
    const inputs = projectionToSessionBlobInputs({ session_id, messages, content_blocks })
    expect(inputs).toHaveLength(2)
    // Writer accepts the bridge output verbatim.
    const result = writeSessionBlobPack({ session_id, epoch: 1, messages: inputs }, identityCompressor)
    expect(result.header.page_count).toBe(1)
    const page = result.header.pages[0]!
    expect(page.message_count).toBe(2)
    expect(page.session_id).toBe(session_id)
  })
})
