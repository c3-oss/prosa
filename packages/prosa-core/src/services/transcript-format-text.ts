import type { SessionTranscript, TranscriptBlock, TranscriptToolCall, TranscriptTurn } from './transcript.js'

/** Options controlling the textual transcript rendering. */
export interface FormatTranscriptTextOptions {
  /** When true, thinking blocks are rendered in full (dim/italic). Default false. */
  showThinking?: boolean
  /** Max preview/output lines to keep per tool result; over-long output is truncated. */
  maxOutputLines?: number
  /** Emit ANSI color escapes. Detect TTY at call site and pass the boolean. */
  color?: boolean
}

const DEFAULT_MAX_OUTPUT_LINES = 40

/** Foreground ANSI color codes used for role-tinted section headers. */
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
} as const

const ROLE_COLOR: Record<TranscriptTurn['role'], keyof typeof ANSI> = {
  user: 'magenta',
  assistant: 'cyan',
  tool: 'yellow',
  system_prompt: 'gray',
  developer: 'gray',
  operational: 'gray',
}

/**
 * Render a `SessionTranscript` as plaintext (optionally ANSI-colored).
 *
 * Layout: a metadata header (title, ids, models, confidence), then one section
 * per turn with a role-tinted header and inline blocks/tool-call summaries.
 * Thinking blocks collapse to one line by default; tool outputs truncate at
 * `maxOutputLines` and surface CAS object ids for full retrieval downstream.
 */
export function formatTranscriptText(transcript: SessionTranscript, options: FormatTranscriptTextOptions = {}): string {
  const showThinking = options.showThinking ?? false
  const maxOutputLines = options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES
  const color = options.color ?? false

  const out: string[] = []
  out.push(...renderHeader(transcript, color))

  for (const turn of transcript.turns) {
    out.push('')
    out.push(...renderTurn(turn, { color, showThinking, maxOutputLines }))
  }

  if (transcript.unattachedToolCalls.length > 0) {
    out.push('')
    out.push(colorize('── tool calls (unattached) ──', ANSI.gray, color))
    for (const call of transcript.unattachedToolCalls) {
      out.push(...renderToolCallLines(call, '', { color, maxOutputLines }))
    }
  }

  return `${out.join('\n')}\n`
}

function renderHeader(transcript: SessionTranscript, color: boolean): string[] {
  const s = transcript.session
  const title = s.title?.trim() || `${s.source_tool} session ${s.source_session_id}`
  const lines: string[] = []
  lines.push(colorize(`# ${title}`, ANSI.bold, color))
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

function renderTurn(
  turn: TranscriptTurn,
  ctx: { color: boolean; showThinking: boolean; maxOutputLines: number },
): string[] {
  const lines: string[] = []
  const colorCode = ANSI[ROLE_COLOR[turn.role] ?? 'gray']
  const meta: string[] = []
  if (turn.model) meta.push(turn.model)
  if (turn.timestamp) meta.push(turn.timestamp)
  const metaSuffix = meta.length > 0 ? ` · ${meta.join(' · ')}` : ''
  lines.push(colorize(`[${turn.role}]${metaSuffix}`, colorCode, ctx.color))

  for (const block of turn.blocks) {
    lines.push(...renderBlock(block, ctx))
  }
  for (const call of turn.toolCalls) {
    lines.push(...renderToolCallLines(call, '  ', { color: ctx.color, maxOutputLines: ctx.maxOutputLines }))
  }
  return lines
}

function renderBlock(
  block: TranscriptBlock,
  ctx: { color: boolean; showThinking: boolean; maxOutputLines: number },
): string[] {
  const isThinking = block.hidden || block.blockType === 'thinking'
  if (isThinking && !ctx.showThinking) {
    const charCount = block.text ? block.text.length : 0
    return [colorize(`  ▶ thinking (≈${charCount} chars)`, ANSI.gray, ctx.color)]
  }

  if (block.text == null) {
    // Body wasn't inlined (oversize) or block has no text payload.
    if (block.textObjectId) {
      return [colorize(`  ▶ ${block.blockType} (oversize; objectId=${block.textObjectId})`, ANSI.gray, ctx.color)]
    }
    return []
  }

  if (isThinking) {
    const lines = block.text.split('\n')
    return lines.map((l) => colorize(`  ${l}`, `${ANSI.dim}${ANSI.italic}`, ctx.color))
  }

  return block.text.split('\n').map((l) => `  ${l}`)
}

function renderToolCallLines(
  call: TranscriptToolCall,
  indent: string,
  ctx: { color: boolean; maxOutputLines: number },
): string[] {
  const lines: string[] = []
  const statusBits: string[] = []
  if (call.status) statusBits.push(call.status)
  if (call.result?.isError) statusBits.push('ERROR')
  const statusSuffix = statusBits.length > 0 ? ` [${statusBits.join(' · ')}]` : ''
  lines.push(colorize(`${indent}▶ tool: ${call.toolName}${statusSuffix}`, ANSI.yellow, ctx.color))

  if (call.command) {
    lines.push(`${indent}  $ ${call.command}`)
  }
  if (call.path) {
    lines.push(`${indent}  path: ${call.path}`)
  }
  if (call.argsInline) {
    // Indent args under the tool header; truncate to maxOutputLines.
    const argsLines = call.argsInline.split('\n')
    const shown = argsLines.slice(0, ctx.maxOutputLines)
    for (const l of shown) lines.push(`${indent}  ${l}`)
    if (argsLines.length > ctx.maxOutputLines) {
      lines.push(
        colorize(
          `${indent}  … (${argsLines.length - ctx.maxOutputLines} more lines; use --max-output-lines or open via objectId=${call.argsObjectId ?? '?'})`,
          ANSI.gray,
          ctx.color,
        ),
      )
    }
  } else if (call.argsObjectId) {
    lines.push(colorize(`${indent}  args: objectId=${call.argsObjectId} (oversize)`, ANSI.gray, ctx.color))
  }

  if (call.result?.preview) {
    const previewLines = call.result.preview.split('\n')
    const shown = previewLines.slice(0, ctx.maxOutputLines)
    lines.push(colorize(`${indent}  ─ result ─`, ANSI.gray, ctx.color))
    for (const l of shown) lines.push(`${indent}  ${l}`)
    if (previewLines.length > ctx.maxOutputLines) {
      const objectId = call.result.outputObjectId ?? call.result.stdoutObjectId ?? call.result.stderrObjectId
      lines.push(
        colorize(
          `${indent}  … (${previewLines.length - ctx.maxOutputLines} more lines; use --max-output-lines or open via objectId=${objectId ?? '?'})`,
          ANSI.gray,
          ctx.color,
        ),
      )
    }
  } else if (call.result?.outputObjectId || call.result?.stdoutObjectId) {
    const objectId = call.result.outputObjectId ?? call.result.stdoutObjectId
    lines.push(colorize(`${indent}  result objectId=${objectId}`, ANSI.gray, ctx.color))
  }

  return lines
}

/** Wrap `s` in `code` when `color` is true; return `s` unchanged otherwise. */
function colorize(s: string, code: string, color: boolean): string {
  if (!color) return s
  return `${code}${s}${ANSI.reset}`
}
