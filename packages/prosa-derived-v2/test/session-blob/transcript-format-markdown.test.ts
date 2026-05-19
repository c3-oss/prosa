// Tests for `formatTranscriptMarkdownV2`.

import { describe, expect, it } from 'vitest'

import type { TranscriptMessage } from '../../src/session-blob/reader.js'
import { formatTranscriptMarkdownV2 } from '../../src/session-blob/transcript-format-markdown.js'

function inlineMsg(
  ordinal: number,
  role: string,
  text: string,
  opts: { turn?: string; ts?: string; blockType?: string; blockId?: string } = {},
): TranscriptMessage {
  return {
    message_id: `msg_${ordinal.toString().padStart(6, '0')}`,
    ordinal,
    role,
    timestamp: opts.ts ?? null,
    turn_id: opts.turn ?? null,
    blocks: [
      {
        block_id: opts.blockId ?? `blk_${ordinal}_0`,
        block_type: opts.blockType ?? 'text',
        body: { kind: 'inline', text, byte_length: new TextEncoder().encode(text).length },
      },
    ],
    page_indices: [0],
  }
}

describe('formatTranscriptMarkdownV2', () => {
  it('renders a single-line plain-text inline block as a heading + paragraph', () => {
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'user', 'hello world')])
    expect(out).toBe('## #0 — user\n\nhello world\n')
  })

  it('includes the timestamp + turn metadata line between heading and body', () => {
    const out = formatTranscriptMarkdownV2([
      inlineMsg(0, 'user', 'hi', { ts: '2026-05-19T00:00:00.000Z', turn: 'tur_0' }),
    ])
    expect(out).toBe('## #0 — user\n\n`2026-05-19T00:00:00.000Z` · turn `tur_0`\n\nhi\n')
  })

  it('renders multi-line inline text as a fenced code block with block metadata', () => {
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'assistant', 'line one\nline two')])
    expect(out).toBe(
      ['## #0 — assistant', '', '**`blk_0_0`** · `text`', '', '```', 'line one', 'line two', '```', ''].join('\n'),
    )
  })

  it('fences inline text that contains a backtick to avoid breaking the paragraph', () => {
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'user', 'this `code` here')])
    expect(out).toContain('```')
    expect(out).toContain('this `code` here')
  })

  it('separates successive messages with a blank line', () => {
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'user', 'a'), inlineMsg(1, 'assistant', 'b')])
    expect(out).toBe('## #0 — user\n\na\n\n## #1 — assistant\n\nb\n')
  })

  it('renders cas_ref blocks as a blockquote with id + bytes + mime and an indented preview fence', () => {
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
            object_id: 'cas:abc',
            byte_length: 4096,
            preview: 'first\nsecond',
            mime_type: 'text/plain',
          },
        },
      ],
      page_indices: [0],
    }
    const out = formatTranscriptMarkdownV2([msg])
    expect(out).toBe(
      [
        '## #0 — assistant',
        '',
        '> **`blk_0_0`** · `tool_result` → `cas:abc` (4096 bytes, `text/plain`)',
        '>',
        '> ```',
        '> first',
        '> second',
        '> ```',
        '',
      ].join('\n'),
    )
  })

  it('omits mime suffix when absent and skips the preview block when empty', () => {
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
    const out = formatTranscriptMarkdownV2([msg])
    expect(out).toBe('## #0 — assistant\n\n> **`blk_0_0`** · `tool_result` → `cas:def` (0 bytes)\n')
  })

  it('renders an empty inline body as the italic empty marker', () => {
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'user', '')])
    expect(out).toBe('## #0 — user\n\n_(empty `text` block `blk_0_0`)_\n')
  })

  it('returns the empty string when given no messages', () => {
    expect(formatTranscriptMarkdownV2([])).toBe('')
  })

  it('respects startOrdinal / endOrdinal inclusive bounds', () => {
    const messages = [inlineMsg(0, 'user', 'a'), inlineMsg(1, 'assistant', 'b'), inlineMsg(2, 'user', 'c')]
    const out = formatTranscriptMarkdownV2(messages, { startOrdinal: 1, endOrdinal: 1 })
    expect(out).toBe('## #1 — assistant\n\nb\n')
  })

  it('emits the document header with includeHeader on a LoadedTranscriptFromBundle input', () => {
    const out = formatTranscriptMarkdownV2(
      {
        epoch: 4,
        path: '/tmp/store/derived/session-blob/epoch-4/ses_alpha.pack',
        pack_digest: 'pack:abc',
        messages: [inlineMsg(0, 'user', 'hi')],
      },
      { includeHeader: true },
    )
    expect(out.startsWith('# Transcript\n')).toBe(true)
    expect(out).toContain('- **epoch**: 4')
    expect(out).toContain('- **pack_digest**: `pack:abc`')
    expect(out).toContain('- **path**: `/tmp/store/derived/session-blob/epoch-4/ses_alpha.pack`')
    expect(out).toContain('- **message_count**: 1')
    expect(out).toContain('\n---\n')
    expect(out).toContain('## #0 — user')
  })

  it('CQ-106: escalates the fence past a triple-backtick run inside inline text', () => {
    // Three backticks inside content would close a triple-backtick fence early
    // and let the rest of the transcript escape into Markdown structure. The
    // fix uses a four-backtick fence in this case.
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'user', 'before\n```\nfenced\n```\nafter')])
    // The fence we emit must be four backticks (one longer than the
    // longest inner run) so the inner ``` cannot close the block early.
    // Asserting on both opening and closing fences anchored to the body
    // bytes catches any drift.
    expect(out).toContain('````\nbefore\n```\nfenced\n```\nafter\n````')
  })

  it('CQ-106: escalates the fence past longer backtick runs in inline text', () => {
    // Five-backtick run inside content → six-backtick fence.
    const out = formatTranscriptMarkdownV2([inlineMsg(0, 'user', 'a\n`````\nb\n`````\nc')])
    expect(out).toContain('``````\na\n`````\nb\n`````\nc\n``````')
  })

  it('CQ-106: escalates the fence past a triple-backtick run inside a cas_ref preview', () => {
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
            object_id: 'cas:abc',
            byte_length: 1024,
            preview: '```fenced\nin preview\n```',
          },
        },
      ],
      page_indices: [0],
    }
    const out = formatTranscriptMarkdownV2([msg])
    expect(out).toContain('> ````')
    expect(out).toContain('> ```fenced')
    expect(out).toContain('> in preview')
    // Closing fence is also four backticks.
    expect(out).toMatch(/> ````\n/)
  })

  it('skips the document header when includeHeader is false (default)', () => {
    const out = formatTranscriptMarkdownV2({
      epoch: 4,
      path: '/tmp/x',
      pack_digest: 'pack:abc',
      messages: [inlineMsg(0, 'user', 'hi')],
    })
    expect(out.startsWith('## #0 — user')).toBe(true)
  })
})
