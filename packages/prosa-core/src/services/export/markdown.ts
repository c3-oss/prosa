import type { Bundle } from '../../core/bundle.js'
import { loadTranscript } from '../transcript.js'
import type { TranscriptToolCall } from '../transcript.js'

/**
 * Render a session into Markdown. Big tool outputs aren't dumped inline:
 * we show a preview line plus a `[object: blake3:…]` reference, leaving the
 * raw bytes in the CAS for downstream tools.
 *
 * Built on top of {@link loadTranscript} so the CLI's `session show --format
 * markdown` path and `prosa export session --format markdown` share one
 * resolution pipeline (inline + CAS text + tool result preview).
 */
export async function exportSessionMarkdown(bundle: Bundle, sessionId: string): Promise<string> {
  // We resolve full text bodies for markdown export so the dumped file is
  // self-contained; bump the inline budget high enough to avoid truncation
  // on the same blocks the previous renderer would have inlined.
  const transcript = await loadTranscript(bundle, sessionId, { maxInlineBytes: Number.MAX_SAFE_INTEGER })
  if (!transcript) {
    throw new Error(`session not found: ${sessionId}`)
  }

  const session = transcript.session
  const lines: string[] = []
  const title = session.title?.trim() || `${session.source_tool} session ${session.source_session_id}`
  lines.push(`# ${title}`, '')
  lines.push(`- **source**: ${session.source_tool}`)
  lines.push(`- **session_id**: \`${session.session_id}\``)
  lines.push(`- **source_session_id**: \`${session.source_session_id}\``)
  if (session.start_ts) lines.push(`- **start**: ${session.start_ts}`)
  if (session.end_ts) lines.push(`- **end**: ${session.end_ts}`)
  if (session.cwd_initial) lines.push(`- **cwd**: \`${session.cwd_initial}\``)
  if (session.git_branch_initial) lines.push(`- **git branch**: ${session.git_branch_initial}`)
  if (session.model_first || session.model_last) {
    lines.push(`- **models**: ${session.model_first ?? '?'} → ${session.model_last ?? session.model_first ?? '?'}`)
  }
  lines.push(`- **timeline confidence**: ${session.timeline_confidence}`)
  lines.push('')

  for (const turn of transcript.turns) {
    const ts = turn.timestamp ? ` · ${turn.timestamp}` : ''
    const model = turn.model ? ` · ${turn.model}` : ''
    lines.push(`## ${turn.role}${model}${ts}`, '')

    for (const block of turn.blocks) {
      // Preserve historical markdown behavior: skip blocks the old query
      // filtered out (`visibility='default'`-only) and drop blocks with no
      // resolved text payload.
      if (block.hidden) continue
      if (block.text == null) continue
      lines.push(block.text, '')
    }

    for (const call of turn.toolCalls) {
      lines.push(renderToolCallMarkdown(call), '')
    }
  }

  // Tool calls that didn't bind to any specific message (legacy / event-only).
  if (transcript.unattachedToolCalls.length > 0) {
    lines.push('## tool calls (unattached)', '')
    for (const call of transcript.unattachedToolCalls) {
      lines.push(renderToolCallMarkdown(call), '')
    }
  }

  return `${lines.join('\n')}\n`
}

/** Renders command, path, status, and preview for one Markdown tool-call block. */
function renderToolCallMarkdown(c: TranscriptToolCall): string {
  const status = c.status ? ` · ${c.status}` : ''
  const errFlag = c.result?.isError ? ' · ERROR' : ''
  const lines: string[] = []
  lines.push(`### tool: ${c.toolName}${status}${errFlag}`)
  if (c.command) {
    lines.push('```sh', c.command, '```')
  }
  if (c.path) lines.push(`*path:* \`${c.path}\``)
  if (c.result?.preview) {
    lines.push('```')
    lines.push(c.result.preview)
    lines.push('```')
  }
  return lines.join('\n')
}
