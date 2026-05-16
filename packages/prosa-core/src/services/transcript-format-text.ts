import type { SessionTranscript, TranscriptBlock, TranscriptToolCall, TranscriptTurn } from './transcript.js'

/** Options controlling the textual transcript rendering. */
export interface FormatTranscriptTextOptions {
  /** When true, thinking blocks are rendered in full. Default false. */
  showThinking?: boolean
  /** Max preview/output lines to keep per tool result; over-long output is truncated. */
  maxOutputLines?: number
  /**
   * Accepted for source-compat with prior releases. Ignored: this formatter
   * always emits plain text (no ANSI escapes) so piped output stays clean.
   * Callers that want colored interactive output should use Ink directly
   * (apps/cli ships `renderTranscriptInk`).
   */
  color?: boolean
}

const DEFAULT_MAX_OUTPUT_LINES = 40

/**
 * Render a `SessionTranscript` as plaintext. Output is always ANSI-free so it
 * round-trips through pipes (`prosa session show --format text > file.txt`).
 *
 * Layout: a metadata header (title, ids, models, confidence), then one section
 * per turn with a role header and inline blocks/tool-call summaries. Thinking
 * blocks collapse to one line by default; tool outputs truncate at
 * `maxOutputLines` and surface CAS object ids for full retrieval downstream.
 */
export function formatTranscriptText(transcript: SessionTranscript, options: FormatTranscriptTextOptions = {}): string {
  const showThinking = options.showThinking ?? false
  const maxOutputLines = options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES

  const out: string[] = []
  out.push(...renderHeader(transcript))

  for (const turn of transcript.turns) {
    out.push('')
    out.push(...renderTurn(turn, { showThinking, maxOutputLines }))
  }

  if (transcript.unattachedToolCalls.length > 0) {
    out.push('')
    out.push('── tool calls (unattached) ──')
    for (const call of transcript.unattachedToolCalls) {
      out.push(...renderToolCallLines(call, '', { maxOutputLines }))
    }
  }

  return `${out.join('\n')}\n`
}

function renderHeader(transcript: SessionTranscript): string[] {
  const s = transcript.session
  const title = s.title?.trim() || `${s.source_tool} session ${s.source_session_id}`
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push(`source:     ${s.source_tool}`)
  lines.push(`session_id: ${s.session_id}`)
  lines.push(`source_id:  ${s.source_session_id}`)
  if (s.start_ts) lines.push(`start:      ${s.start_ts}`)
  if (s.end_ts) lines.push(`end:        ${s.end_ts}`)
  if (s.model_first || s.model_last) {
    lines.push(`models:     ${s.model_first ?? '?'} → ${s.model_last ?? s.model_first ?? '?'}`)
  }
  lines.push(`confidence: ${s.timeline_confidence}`)
  return lines
}

function renderTurn(turn: TranscriptTurn, ctx: { showThinking: boolean; maxOutputLines: number }): string[] {
  const lines: string[] = []
  const meta: string[] = []
  if (turn.model) meta.push(turn.model)
  if (turn.timestamp) meta.push(turn.timestamp)
  const metaSuffix = meta.length > 0 ? ` · ${meta.join(' · ')}` : ''
  lines.push(`[${turn.role}]${metaSuffix}`)

  for (const block of turn.blocks) {
    lines.push(...renderBlock(block, ctx))
  }
  for (const call of turn.toolCalls) {
    lines.push(...renderToolCallLines(call, '  ', { maxOutputLines: ctx.maxOutputLines }))
  }
  return lines
}

function renderBlock(block: TranscriptBlock, ctx: { showThinking: boolean; maxOutputLines: number }): string[] {
  const isThinking = block.hidden || block.blockType === 'thinking'
  if (isThinking && !ctx.showThinking) {
    const charCount = block.text ? block.text.length : 0
    return [`  ▶ thinking (≈${charCount} chars)`]
  }

  if (block.text == null) {
    // Body wasn't inlined (oversize) or block has no text payload.
    if (block.textObjectId) {
      return [`  ▶ ${block.blockType} (oversize; objectId=${block.textObjectId})`]
    }
    return []
  }

  return block.text.split('\n').map((l) => `  ${l}`)
}

function renderToolCallLines(call: TranscriptToolCall, indent: string, ctx: { maxOutputLines: number }): string[] {
  const lines: string[] = []
  const statusBits: string[] = []
  if (call.status) statusBits.push(call.status)
  if (call.result?.isError) statusBits.push('ERROR')
  const statusSuffix = statusBits.length > 0 ? ` [${statusBits.join(' · ')}]` : ''
  lines.push(`${indent}▶ tool: ${call.toolName}${statusSuffix}`)

  if (call.command) {
    lines.push(`${indent}  $ ${call.command}`)
  }
  if (call.path) {
    lines.push(`${indent}  path: ${call.path}`)
  }
  if (call.argsInline) {
    const argsLines = call.argsInline.split('\n')
    const shown = argsLines.slice(0, ctx.maxOutputLines)
    for (const l of shown) lines.push(`${indent}  ${l}`)
    if (argsLines.length > ctx.maxOutputLines) {
      lines.push(
        `${indent}  … (${argsLines.length - ctx.maxOutputLines} more lines; use --max-output-lines or open via objectId=${call.argsObjectId ?? '?'})`,
      )
    }
  } else if (call.argsObjectId) {
    lines.push(`${indent}  args: objectId=${call.argsObjectId} (oversize)`)
  }

  if (call.result?.preview) {
    const previewLines = call.result.preview.split('\n')
    const shown = previewLines.slice(0, ctx.maxOutputLines)
    lines.push(`${indent}  ─ result ─`)
    for (const l of shown) lines.push(`${indent}  ${l}`)
    if (previewLines.length > ctx.maxOutputLines) {
      const objectId = call.result.outputObjectId ?? call.result.stdoutObjectId ?? call.result.stderrObjectId
      lines.push(
        `${indent}  … (${previewLines.length - ctx.maxOutputLines} more lines; use --max-output-lines or open via objectId=${objectId ?? '?'})`,
      )
    }
  } else if (call.result?.outputObjectId || call.result?.stdoutObjectId) {
    const objectId = call.result.outputObjectId ?? call.result.stdoutObjectId
    lines.push(`${indent}  result objectId=${objectId}`)
  }

  return lines
}
