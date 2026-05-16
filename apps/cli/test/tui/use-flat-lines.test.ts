import type {
  SessionRow,
  SessionTranscript,
  TranscriptBlock,
  TranscriptToolCall,
  TranscriptTurn,
} from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'
import { type FlatLine, flattenTranscript } from '../../src/tui/use-flat-lines.js'

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 'sess-1',
    source_tool: 'codex',
    source_session_id: 'codex-1',
    project_id: null,
    parent_session_id: null,
    is_subagent: 0,
    title: 'Test session',
    start_ts: '2026-05-15T00:00:00.000Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: 'gpt-5',
    model_last: 'gpt-5',
    status: 'ok',
    timeline_confidence: 'high',
    message_count: 0,
    tool_call_count: 0,
    ...overrides,
  } as SessionRow
}

function makeBlock(overrides: Partial<TranscriptBlock>): TranscriptBlock {
  return {
    blockId: 'b1',
    blockType: 'text',
    text: '',
    textObjectId: null,
    hidden: false,
    mimeType: null,
    isError: false,
    ...overrides,
  }
}

function makeTurn(overrides: Partial<TranscriptTurn>): TranscriptTurn {
  return {
    messageId: 'm1',
    ordinal: 0,
    role: 'user',
    model: null,
    timestamp: null,
    blocks: [],
    toolCalls: [],
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return {
    toolCallId: 'tc1',
    toolName: 'bash',
    canonicalToolType: 'bash',
    argsInline: null,
    argsObjectId: null,
    command: null,
    path: null,
    status: 'ok',
    timestampStart: null,
    result: null,
    ...overrides,
  }
}

function transcript(turns: TranscriptTurn[], unattached: TranscriptToolCall[] = []): SessionTranscript {
  return {
    session: makeSession({ message_count: turns.length }),
    turns,
    unattachedToolCalls: unattached,
  }
}

const baseOpts = { showThinking: false, expandedTurns: new Set<number>(), maxOutputLines: 5 }

describe('flattenTranscript', () => {
  it('emits only the session header for an empty transcript', () => {
    const lines = flattenTranscript(transcript([]), baseOpts)
    expect(lines.every((l: FlatLine) => l.kind === 'session-header')).toBe(true)
    expect(lines).toHaveLength(4)
    expect(lines[0]?.text).toContain('# session sess-1')
  })

  it('emits a turn header and per-output-line block-text for a text turn', () => {
    const turn = makeTurn({
      role: 'assistant',
      blocks: [makeBlock({ text: 'hello\nworld' })],
    })
    const lines = flattenTranscript(transcript([turn]), baseOpts)
    const turnHeader = lines.find((l) => l.kind === 'turn-header')
    expect(turnHeader?.role).toBe('assistant')
    const textLines = lines.filter((l) => l.kind === 'block-text')
    expect(textLines.map((l) => l.text.trim())).toEqual(['hello', 'world'])
  })

  it('collapses thinking blocks by default', () => {
    const turn = makeTurn({
      role: 'assistant',
      blocks: [makeBlock({ blockType: 'thinking', hidden: true, text: 'long internal thought' })],
    })
    const lines = flattenTranscript(transcript([turn]), baseOpts)
    const collapsed = lines.filter((l) => l.kind === 'thinking-collapsed')
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.text).toContain('thinking')
    expect(collapsed[0]?.text).toContain('≈21 chars')
  })

  it('expands thinking blocks when showThinking is true', () => {
    const turn = makeTurn({
      role: 'assistant',
      blocks: [makeBlock({ blockType: 'thinking', hidden: true, text: 'one\ntwo\nthree' })],
    })
    const lines = flattenTranscript(transcript([turn]), { ...baseOpts, showThinking: true })
    const expanded = lines.filter((l) => l.kind === 'thinking-expanded')
    expect(expanded).toHaveLength(3)
    expect(expanded.map((l) => l.text.trim())).toEqual(['one', 'two', 'three'])
  })

  it('emits truncation with objectId when tool output exceeds maxOutputLines', () => {
    const turn = makeTurn({
      role: 'assistant',
      toolCalls: [
        makeToolCall({
          toolName: 'shell',
          command: 'ls',
          result: {
            toolResultId: 'tr1',
            status: 'ok',
            isError: false,
            exitCode: 0,
            durationMs: 1,
            preview: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n'),
            stdoutObjectId: 'cas-stdout',
            stderrObjectId: null,
            outputObjectId: 'cas-output',
          },
        }),
      ],
    })
    const lines = flattenTranscript(transcript([turn]), baseOpts)
    const trunc = lines.find((l) => l.kind === 'tool-call-truncation')
    expect(trunc).toBeDefined()
    expect(trunc?.objectId).toBe('cas-output')
    expect(trunc?.text).toContain('2 more lines')
    const outputs = lines.filter((l) => l.kind === 'tool-call-output')
    expect(outputs).toHaveLength(5)
  })

  it('emits an unattached-header when transcript carries orphan tool calls', () => {
    const orphan = makeToolCall({ toolName: 'orphan-tool', toolCallId: 'tc-orphan' })
    const lines = flattenTranscript(transcript([], [orphan]), baseOpts)
    const header = lines.find((l) => l.kind === 'unattached-header')
    expect(header).toBeDefined()
    const orphanHeader = lines.find((l) => l.kind === 'tool-call-header' && l.text.includes('orphan-tool'))
    expect(orphanHeader).toBeDefined()
  })

  it('surfaces an objectId on block-text when the body is too large to inline', () => {
    const turn = makeTurn({
      role: 'assistant',
      blocks: [makeBlock({ text: null, textObjectId: 'cas-block-1' })],
    })
    const lines = flattenTranscript(transcript([turn]), baseOpts)
    const placeholder = lines.find((l) => l.kind === 'block-text')
    expect(placeholder?.objectId).toBe('cas-block-1')
    expect(placeholder?.text).toContain('press o to open')
  })
})
