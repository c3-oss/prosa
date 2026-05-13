import type { Bundle } from '../../core/bundle.js'
import { getText } from '../../core/cas/index.js'

interface SessionMeta {
  session_id: string
  source_tool: string
  source_session_id: string
  title: string | null
  start_ts: string | null
  end_ts: string | null
  cwd_initial: string | null
  git_branch_initial: string | null
  model_first: string | null
  model_last: string | null
  timeline_confidence: 'high' | 'medium' | 'low'
}

interface MessageRow {
  message_id: string
  role: string
  timestamp: string | null
  ordinal: number
  model: string | null
}

interface BlockRow {
  message_id: string | null
  block_type: string
  text_object_id: string | null
  text_inline: string | null
  ordinal: number
}

interface ToolCallRow {
  tool_call_id: string
  message_id: string | null
  tool_name: string
  command: string | null
  path: string | null
  status: string | null
  timestamp_start: string | null
  is_error: 0 | 1 | null
  preview: string | null
}

/**
 * Render a session into Markdown. Big tool outputs aren't dumped inline:
 * we show a preview line plus a `[object: blake3:…]` reference, leaving the
 * raw bytes in the CAS for downstream tools.
 */
export async function exportSessionMarkdown(bundle: Bundle, sessionId: string): Promise<string> {
  const session = bundle.db
    .prepare<[string], SessionMeta>(
      `SELECT session_id, source_tool, source_session_id, title, start_ts, end_ts,
              cwd_initial, git_branch_initial, model_first, model_last, timeline_confidence
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId)

  if (!session) {
    throw new Error(`session not found: ${sessionId}`)
  }

  const messages = bundle.db
    .prepare<[string], MessageRow>(
      `SELECT message_id, role, timestamp, ordinal, model
         FROM messages WHERE session_id = ? ORDER BY ordinal`,
    )
    .all(sessionId)

  const blocks = bundle.db
    .prepare<[string], BlockRow>(
      `SELECT message_id, block_type, text_object_id, text_inline, ordinal
         FROM content_blocks WHERE session_id = ? ORDER BY ordinal`,
    )
    .all(sessionId)

  const toolCalls = bundle.db
    .prepare<[string], ToolCallRow>(
      `SELECT tc.tool_call_id, tc.message_id, tc.tool_name, tc.command, tc.path,
              tc.status, tc.timestamp_start,
              tr.is_error, tr.preview
         FROM tool_calls tc
         LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id
        WHERE tc.session_id = ? ORDER BY tc.timestamp_start, tc.tool_call_id`,
    )
    .all(sessionId)

  const blocksByMessage = new Map<string, BlockRow[]>()
  for (const b of blocks) {
    if (!b.message_id) continue
    const list = blocksByMessage.get(b.message_id) ?? []
    list.push(b)
    blocksByMessage.set(b.message_id, list)
  }
  const callsByMessage = new Map<string, ToolCallRow[]>()
  for (const c of toolCalls) {
    const key = c.message_id ?? '__unattached__'
    const list = callsByMessage.get(key) ?? []
    list.push(c)
    callsByMessage.set(key, list)
  }

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

  for (const m of messages) {
    const ts = m.timestamp ? ` · ${m.timestamp}` : ''
    const model = m.model ? ` · ${m.model}` : ''
    lines.push(`## ${m.role}${model}${ts}`, '')

    const mblocks = (blocksByMessage.get(m.message_id) ?? []).sort((a, b) => a.ordinal - b.ordinal)
    for (const b of mblocks) {
      const text = await renderBlockText(bundle, b)
      if (text == null) continue
      lines.push(text, '')
    }

    const calls = callsByMessage.get(m.message_id) ?? []
    for (const c of calls) {
      lines.push(renderToolCall(c), '')
    }
  }

  // Tool calls that didn't bind to any specific message (legacy / event-only).
  const unattached = callsByMessage.get('__unattached__') ?? []
  if (unattached.length > 0) {
    lines.push('## tool calls (unattached)', '')
    for (const c of unattached) {
      lines.push(renderToolCall(c), '')
    }
  }

  return `${lines.join('\n')}\n`
}

async function renderBlockText(bundle: Bundle, block: BlockRow): Promise<string | null> {
  if (block.text_inline) return block.text_inline
  if (block.text_object_id) {
    try {
      return await getText(bundle, block.text_object_id)
    } catch {
      return `_[content unavailable: ${block.text_object_id}]_`
    }
  }
  return null
}

function renderToolCall(c: ToolCallRow): string {
  const status = c.status ? ` · ${c.status}` : ''
  const errFlag = c.is_error === 1 ? ' · ERROR' : ''
  const lines: string[] = []
  lines.push(`### tool: ${c.tool_name}${status}${errFlag}`)
  if (c.command) {
    lines.push('```sh', c.command, '```')
  }
  if (c.path) lines.push(`*path:* \`${c.path}\``)
  if (c.preview) {
    lines.push('```')
    lines.push(c.preview)
    lines.push('```')
  }
  return lines.join('\n')
}
