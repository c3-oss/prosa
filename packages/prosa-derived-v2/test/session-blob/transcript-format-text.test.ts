// Tests for `formatTranscriptTextV2` — the v2 transcript text
// renderer. Asserts on the rendered byte shape rather than a
// regex over loose substrings; small format drift is caught
// immediately.

import { describe, expect, it } from 'vitest'

import type { TranscriptMessage } from '../../src/session-blob/reader.js'
import { formatTranscriptTextV2 } from '../../src/session-blob/transcript-format-text.js'

function inlineMsg(
  ordinal: number,
  role: string,
  text: string,
  opts: { turn?: string; ts?: string } = {},
): TranscriptMessage {
  return {
    message_id: `msg_${ordinal.toString().padStart(6, '0')}`,
    ordinal,
    role,
    timestamp: opts.ts ?? null,
    turn_id: opts.turn ?? null,
    blocks: [
      {
        block_id: `blk_${ordinal}_0`,
        block_type: 'text',
        body: { kind: 'inline', text, byte_length: new TextEncoder().encode(text).length },
      },
    ],
    page_indices: [0],
  }
}

describe('formatTranscriptTextV2', () => {
  it('renders a single inline message with role + ordinal header and indented body', () => {
    const out = formatTranscriptTextV2([inlineMsg(0, 'user', 'hello world')])
    expect(out).toBe('[#0] user\n  blk_0_0 | text | inline (11 bytes)\n  hello world\n')
  })

  it('includes timestamp and turn metadata when set', () => {
    const out = formatTranscriptTextV2([inlineMsg(0, 'user', 'hi', { ts: '2026-05-19T00:00:00.000Z', turn: 'tur_0' })])
    expect(out).toBe('[#0] user @ 2026-05-19T00:00:00.000Z (turn: tur_0)\n  blk_0_0 | text | inline (2 bytes)\n  hi\n')
  })

  it('separates successive messages with a blank line and drops the trailing blank', () => {
    const out = formatTranscriptTextV2([inlineMsg(0, 'user', 'a'), inlineMsg(1, 'assistant', 'b')])
    expect(out).toBe(
      [
        '[#0] user',
        '  blk_0_0 | text | inline (1 bytes)',
        '  a',
        '',
        '[#1] assistant',
        '  blk_1_0 | text | inline (1 bytes)',
        '  b',
        '',
      ].join('\n'),
    )
  })

  it('renders cas_ref blocks with object id, byte length, and indented preview', () => {
    const msg: TranscriptMessage = {
      message_id: 'msg_000000',
      ordinal: 0,
      role: 'assistant',
      timestamp: null,
      turn_id: null,
      blocks: [
        {
          block_id: 'blk_0_0',
          block_type: 'tool_result',
          body: {
            kind: 'cas_ref',
            object_id: 'cas:abc123',
            byte_length: 65536,
            preview: 'line one\nline two',
            mime_type: 'text/plain',
          },
        },
      ],
      page_indices: [0],
    }
    const out = formatTranscriptTextV2([msg])
    expect(out).toBe(
      [
        '[#0] assistant',
        '  blk_0_0 | tool_result | cas_ref object:cas:abc123 bytes:65536 mime:text/plain',
        '    line one',
        '    line two',
        '',
      ].join('\n'),
    )
  })

  it('omits the mime_type suffix when absent and the preview line when empty', () => {
    const msg: TranscriptMessage = {
      message_id: 'msg_000000',
      ordinal: 0,
      role: 'assistant',
      timestamp: null,
      turn_id: null,
      blocks: [
        {
          block_id: 'blk_0_0',
          block_type: 'tool_result',
          body: { kind: 'cas_ref', object_id: 'cas:def', byte_length: 0, preview: '' },
        },
      ],
      page_indices: [0],
    }
    const out = formatTranscriptTextV2([msg])
    expect(out).toBe('[#0] assistant\n  blk_0_0 | tool_result | cas_ref object:cas:def bytes:0\n')
  })

  it('returns the empty string when given no messages', () => {
    expect(formatTranscriptTextV2([])).toBe('')
  })

  it('respects startOrdinal / endOrdinal inclusive bounds', () => {
    const messages = [inlineMsg(0, 'user', 'a'), inlineMsg(1, 'assistant', 'b'), inlineMsg(2, 'user', 'c')]
    const out = formatTranscriptTextV2(messages, { startOrdinal: 1, endOrdinal: 1 })
    expect(out).toBe('[#1] assistant\n  blk_1_0 | text | inline (1 bytes)\n  b\n')
  })

  it('emits the pack metadata header when includeHeader is set and the input is a LoadedTranscriptFromBundle', () => {
    const out = formatTranscriptTextV2(
      {
        epoch: 4,
        path: '/tmp/store/derived/session-blob/epoch-4/ses_alpha.pack',
        pack_digest: 'pack:abc',
        messages: [inlineMsg(0, 'user', 'hi')],
      },
      { includeHeader: true },
    )
    expect(out.startsWith('epoch:        4\n')).toBe(true)
    expect(out).toContain('pack_digest:  pack:abc')
    expect(out).toContain('path:         /tmp/store/derived/session-blob/epoch-4/ses_alpha.pack')
    expect(out).toContain('message_count: 1')
    // The blank-line separator between header and messages.
    expect(out).toContain('\n\n[#0] user')
  })

  it('does not emit the header when includeHeader is false (default) even with a loaded transcript input', () => {
    const out = formatTranscriptTextV2({
      epoch: 4,
      path: '/tmp/x',
      pack_digest: 'pack:abc',
      messages: [inlineMsg(0, 'user', 'hi')],
    })
    expect(out.startsWith('[#0] user')).toBe(true)
  })
})
