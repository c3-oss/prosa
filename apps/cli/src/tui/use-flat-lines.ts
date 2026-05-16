import type { SessionTranscript, TranscriptToolCall, TranscriptTurn } from '@c3-oss/prosa-core'

/** Discriminator for a single rendered transcript row. */
export type FlatLineKind =
  | 'session-header'
  | 'turn-header'
  | 'block-text'
  | 'thinking-collapsed'
  | 'thinking-expanded'
  | 'tool-call-header'
  | 'tool-call-input'
  | 'tool-call-output'
  | 'tool-call-truncation'
  | 'separator'
  | 'unattached-header'

/** Roles tracked for color routing in the renderer. */
export type FlatLineRole = 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'

/** One flattened, pre-rendered transcript row consumed by `<TranscriptView>`. */
export interface FlatLine {
  kind: FlatLineKind
  /** Pre-rendered text without ANSI; the renderer applies Ink colors. */
  text: string
  role?: FlatLineRole
  /** Index into `transcript.turns`, when the line belongs to a turn. */
  turnIndex?: number
  /** Index into `turn.blocks`, when the line came from a content block. */
  blockIndex?: number
  /** Index into `turn.toolCalls`, when the line came from a tool call. */
  toolCallIndex?: number
  /** Hint that pressing Enter/`e` toggles this line's expansion. */
  isExpandable?: boolean
  /** CAS object id available for the `o` "open in pager" action. */
  objectId?: string
  isError?: boolean
}

/** Options consumed by `flattenTranscript`. */
export interface FlattenOptions {
  /** When true, every thinking block expands inline regardless of `expandedTurns`. */
  showThinking: boolean
  /** Turns whose thinking blocks should expand even when `showThinking` is false. */
  expandedTurns: Set<number>
  /** Maximum tool-output preview lines to emit before truncating. */
  maxOutputLines: number
}

/** Cap for how many lines of inline tool-call args we emit before truncating. */
const MAX_INPUT_LINES = 4

/**
 * Flatten a `SessionTranscript` into a stable, indexable list of rendered
 * rows. Pure: callers memoize against `transcript` + `opts` to avoid recompute.
 *
 * The output drives both rendering (one `<Text>` per row, colored by `kind`
 * and `role`) and navigation (`selectedLine` indexes directly into the array).
 */
export function flattenTranscript(transcript: SessionTranscript, opts: FlattenOptions): FlatLine[] {
  const lines: FlatLine[] = []
  pushSessionHeader(lines, transcript)

  transcript.turns.forEach((turn, turnIndex) => {
    lines.push({ kind: 'separator', text: '' })
    pushTurn(lines, turn, turnIndex, opts)
  })

  if (transcript.unattachedToolCalls.length > 0) {
    lines.push({ kind: 'separator', text: '' })
    lines.push({ kind: 'unattached-header', text: '── tool calls (unattached) ──' })
    for (const call of transcript.unattachedToolCalls) {
      pushToolCall(lines, call, undefined, undefined, opts)
    }
  }

  return lines
}

function pushSessionHeader(lines: FlatLine[], transcript: SessionTranscript): void {
  const s = transcript.session
  const title = s.title?.trim() || `${s.source_tool} session ${s.source_session_id}`
  lines.push({ kind: 'session-header', text: `# session ${s.session_id}` })
  lines.push({
    kind: 'session-header',
    text: `source: ${s.source_tool}  ·  start: ${s.start_ts ?? '—'}  ·  ${title}`,
  })
  lines.push({
    kind: 'session-header',
    text: `models: ${s.model_first ?? '?'} → ${s.model_last ?? s.model_first ?? '?'}`,
  })
  lines.push({
    kind: 'session-header',
    text: `messages: ${s.message_count}  ·  tool_calls: ${s.tool_call_count}  ·  confidence: ${s.timeline_confidence}`,
  })
}

function pushTurn(lines: FlatLine[], turn: TranscriptTurn, turnIndex: number, opts: FlattenOptions): void {
  const meta: string[] = []
  if (turn.model) meta.push(turn.model)
  if (turn.timestamp) meta.push(turn.timestamp)
  const metaSuffix = meta.length > 0 ? ` · ${meta.join(' · ')}` : ''
  lines.push({
    kind: 'turn-header',
    role: turn.role,
    turnIndex,
    isExpandable: true,
    text: `[${turn.role}]${metaSuffix}`,
  })

  turn.blocks.forEach((block, blockIndex) => {
    const isThinking = block.hidden || block.blockType === 'thinking'
    if (isThinking) {
      const expanded = opts.showThinking || opts.expandedTurns.has(turnIndex)
      if (!expanded) {
        const charCount = block.text ? block.text.length : 0
        lines.push({
          kind: 'thinking-collapsed',
          role: turn.role,
          turnIndex,
          blockIndex,
          isExpandable: true,
          text: `  ▶ thinking (≈${charCount} chars)`,
        })
        return
      }
      const text = block.text ?? ''
      for (const ln of text.split('\n')) {
        lines.push({
          kind: 'thinking-expanded',
          role: turn.role,
          turnIndex,
          blockIndex,
          isExpandable: true,
          text: `  ${ln}`,
        })
      }
      return
    }

    if (block.text == null) {
      // Oversize body or missing payload — surface the CAS pointer so `o`
      // can open it in a pager.
      if (block.textObjectId) {
        lines.push({
          kind: 'block-text',
          role: turn.role,
          turnIndex,
          blockIndex,
          objectId: block.textObjectId,
          text: `  [content: ${block.textObjectId}, press o to open]`,
        })
      }
      return
    }

    for (const ln of block.text.split('\n')) {
      lines.push({
        kind: 'block-text',
        role: turn.role,
        turnIndex,
        blockIndex,
        isError: block.isError,
        text: `  ${ln}`,
      })
    }
  })

  turn.toolCalls.forEach((call, toolCallIndex) => {
    pushToolCall(lines, call, turnIndex, toolCallIndex, opts)
  })
}

function pushToolCall(
  lines: FlatLine[],
  call: TranscriptToolCall,
  turnIndex: number | undefined,
  toolCallIndex: number | undefined,
  opts: FlattenOptions,
): void {
  const statusBits: string[] = []
  if (call.status) statusBits.push(call.status)
  if (call.result?.isError) statusBits.push('ERROR')
  const statusSuffix = statusBits.length > 0 ? ` [${statusBits.join(' · ')}]` : ''
  lines.push({
    kind: 'tool-call-header',
    role: 'tool',
    turnIndex,
    toolCallIndex,
    isExpandable: true,
    isError: call.result?.isError === true,
    text: `  ▶ tool: ${call.toolName}${statusSuffix}`,
  })

  // Input summary: prefer command/path; otherwise truncated args JSON.
  const inputLines: string[] = []
  if (call.command) inputLines.push(`$ ${call.command}`)
  if (call.path) inputLines.push(`path: ${call.path}`)
  if (inputLines.length === 0 && call.argsInline) {
    const argLines = call.argsInline.split('\n')
    const shown = argLines.slice(0, MAX_INPUT_LINES)
    for (const ln of shown) inputLines.push(ln)
    if (argLines.length > MAX_INPUT_LINES) {
      inputLines.push(`… (${argLines.length - MAX_INPUT_LINES} more args lines)`)
    }
  } else if (inputLines.length === 0 && call.argsObjectId) {
    inputLines.push(`args: objectId=${call.argsObjectId} (oversize)`)
  }
  for (const ln of inputLines.slice(0, MAX_INPUT_LINES + 1)) {
    lines.push({
      kind: 'tool-call-input',
      role: 'tool',
      turnIndex,
      toolCallIndex,
      objectId: call.argsObjectId ?? undefined,
      text: `    ${ln}`,
    })
  }

  if (call.result) {
    const preview = call.result.preview ?? ''
    const outLines = preview.length > 0 ? preview.split('\n') : []
    const shown = outLines.slice(0, opts.maxOutputLines)
    for (const ln of shown) {
      lines.push({
        kind: 'tool-call-output',
        role: 'tool',
        turnIndex,
        toolCallIndex,
        isError: call.result.isError,
        text: `    ${ln}`,
      })
    }
    const overflow = outLines.length - opts.maxOutputLines
    const cas = call.result.outputObjectId ?? call.result.stdoutObjectId ?? call.result.stderrObjectId
    if (overflow > 0 || call.result.outputObjectId != null) {
      const moreText =
        overflow > 0
          ? `    … (${overflow} more lines; press o to open in pager)`
          : '    … (press o to open full output in pager)'
      lines.push({
        kind: 'tool-call-truncation',
        role: 'tool',
        turnIndex,
        toolCallIndex,
        objectId: cas ?? undefined,
        text: moreText,
      })
    }
  }
}
