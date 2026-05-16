import type { Bundle } from '../core/bundle.js'
import { getText } from '../core/cas/index.js'
import type { ObjectId } from '../core/cas/index.js'
import type { SessionRow } from './sessions.js'

/** Default inline-text byte budget for block resolution. Larger blobs stay in CAS. */
const DEFAULT_MAX_INLINE_BYTES = 64 * 1024
/** Default inline-text byte budget for tool-call args JSON. */
const DEFAULT_MAX_ARGS_INLINE_BYTES = 8 * 1024

/** Matched `tool_results` row attached to its owning `TranscriptToolCall`. */
export interface TranscriptToolResult {
  toolResultId: string
  status: string | null
  isError: boolean
  exitCode: number | null
  durationMs: number | null
  preview: string | null
  /** Full stdout, if any, is in CAS; pass-through id so renderers can fetch on demand. */
  stdoutObjectId: string | null
  /** Full stderr, if any, is in CAS; pass-through id so renderers can fetch on demand. */
  stderrObjectId: string | null
  /** Full output, if any, is in CAS; pass-through id so renderers can fetch on demand. */
  outputObjectId: string | null
}

/** Tool invocation rendered alongside its owning turn (or as unattached). */
export interface TranscriptToolCall {
  toolCallId: string
  toolName: string
  canonicalToolType: string | null
  /** Resolved args JSON text when ≤ maxArgsInlineBytes; otherwise null. */
  argsInline: string | null
  /** Source CAS id for args. Kept so renderers can fetch on demand. */
  argsObjectId: string | null
  command: string | null
  path: string | null
  status: string | null
  timestampStart: string | null
  result: TranscriptToolResult | null
}

/** One content block in a message: text, thinking, tool_use, tool_result, etc. */
export interface TranscriptBlock {
  blockId: string
  blockType: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string
  /** Resolved inline OR fetched from CAS when ≤ maxInlineBytes. Null for oversize. */
  text: string | null
  /** Source CAS id for text. Kept so renderers can fetch oversized blobs on demand. */
  textObjectId: string | null
  /** Mirrors `content_blocks.visibility = 'hidden_by_default'`. */
  hidden: boolean
  mimeType: string | null
  isError: boolean
}

/** One conversational turn: a message plus its blocks and outbound tool calls. */
export interface TranscriptTurn {
  messageId: string
  ordinal: number
  role: 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'
  model: string | null
  timestamp: string | null
  blocks: TranscriptBlock[]
  toolCalls: TranscriptToolCall[]
}

/** Full structured transcript for one session. */
export interface SessionTranscript {
  session: SessionRow
  turns: TranscriptTurn[]
  /** Tool calls whose `message_id` is NULL (legacy / event-only imports). */
  unattachedToolCalls: TranscriptToolCall[]
}

/** Options controlling how aggressively the loader inlines CAS-backed text. */
export interface LoadTranscriptOptions {
  /** Maximum UTF-8 byte size to inline a block's text. Default 64KB. */
  maxInlineBytes?: number
  /** Maximum UTF-8 byte size to inline a tool-call's args JSON. Default 8KB. */
  maxArgsInlineBytes?: number
}

interface MessageRow {
  message_id: string
  role: string
  timestamp: string | null
  ordinal: number
  model: string | null
}

interface BlockRow {
  block_id: string
  message_id: string | null
  block_type: string
  text_object_id: string | null
  text_inline: string | null
  ordinal: number
  mime_type: string | null
  is_error: 0 | 1 | null
  visibility: 'default' | 'hidden_by_default' | 'audit_only'
}

interface ToolCallRow {
  tool_call_id: string
  message_id: string | null
  tool_name: string
  canonical_tool_type: string | null
  args_object_id: string | null
  command: string | null
  path: string | null
  status: string | null
  timestamp_start: string | null
}

interface ToolResultRow {
  tool_call_id: string | null
  tool_result_id: string
  status: string | null
  is_error: 0 | 1 | null
  exit_code: number | null
  duration_ms: number | null
  preview: string | null
  stdout_object_id: string | null
  stderr_object_id: string | null
  output_object_id: string | null
}

/**
 * Assemble a session's full conversation — messages, content blocks, and tool
 * calls with matched results — from the local bundle SQLite. Returns null
 * when the session is absent (callers handle "not found" themselves).
 *
 * Text bodies are resolved inline when small enough; oversize bodies surface
 * only as `textObjectId`/`argsObjectId` so renderers can fetch on demand.
 */
export async function loadTranscript(
  bundle: Bundle,
  sessionId: string,
  options: LoadTranscriptOptions = {},
): Promise<SessionTranscript | null> {
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  const maxArgsInlineBytes = options.maxArgsInlineBytes ?? DEFAULT_MAX_ARGS_INLINE_BYTES

  const session = bundle.db
    .prepare<[string], SessionRow>(
      `SELECT s.session_id,
              s.source_tool,
              s.source_session_id,
              s.project_id,
              s.parent_session_id,
              s.is_subagent,
              s.title,
              s.start_ts,
              s.end_ts,
              s.cwd_initial,
              s.git_branch_initial,
              s.model_first,
              s.model_last,
              s.status,
              s.timeline_confidence,
              (SELECT count(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
              (SELECT count(*) FROM tool_calls tc WHERE tc.session_id = s.session_id) AS tool_call_count
         FROM sessions s
        WHERE s.session_id = ?`,
    )
    .get(sessionId)

  if (!session) return null

  const messages = bundle.db
    .prepare<[string], MessageRow>(
      `SELECT message_id, role, timestamp, ordinal, model
         FROM messages WHERE session_id = ? ORDER BY ordinal`,
    )
    .all(sessionId)

  // Include hidden_by_default rows; the renderer decides whether to display
  // thinking blocks. audit_only stays excluded (privacy posture).
  const blocks = bundle.db
    .prepare<[string], BlockRow>(
      `SELECT block_id, message_id, block_type, text_object_id, text_inline,
              ordinal, mime_type, is_error, visibility
         FROM content_blocks
        WHERE session_id = ? AND visibility != 'audit_only'
        ORDER BY message_id, ordinal`,
    )
    .all(sessionId)

  const toolCalls = bundle.db
    .prepare<[string], ToolCallRow>(
      `SELECT tool_call_id, message_id, tool_name, canonical_tool_type, args_object_id,
              command, path, status, timestamp_start
         FROM tool_calls WHERE session_id = ?
         ORDER BY timestamp_start, tool_call_id`,
    )
    .all(sessionId)

  // LEFT JOIN equivalent: one query gets all results for the session, then we
  // group by tool_call_id below. Multiple results per call are possible in
  // theory; we keep the latest by tool_result_id ordering.
  const toolResults = bundle.db
    .prepare<[string], ToolResultRow>(
      `SELECT tool_call_id, tool_result_id, status, is_error, exit_code, duration_ms,
              preview, stdout_object_id, stderr_object_id, output_object_id
         FROM tool_results WHERE session_id = ?`,
    )
    .all(sessionId)

  const resultByCallId = new Map<string, ToolResultRow>()
  for (const r of toolResults) {
    if (!r.tool_call_id) continue
    resultByCallId.set(r.tool_call_id, r)
  }

  // Group blocks under their owning message_id; orphan blocks (event-only)
  // are dropped from the per-turn view but kept reachable via raw queries.
  const blocksByMessage = new Map<string, BlockRow[]>()
  for (const b of blocks) {
    if (!b.message_id) continue
    const list = blocksByMessage.get(b.message_id) ?? []
    list.push(b)
    blocksByMessage.set(b.message_id, list)
  }

  const callsByMessage = new Map<string, ToolCallRow[]>()
  const unattached: ToolCallRow[] = []
  for (const c of toolCalls) {
    if (c.message_id == null) {
      unattached.push(c)
      continue
    }
    const list = callsByMessage.get(c.message_id) ?? []
    list.push(c)
    callsByMessage.set(c.message_id, list)
  }

  const turns: TranscriptTurn[] = []
  for (const m of messages) {
    const mblocks = (blocksByMessage.get(m.message_id) ?? []).sort((a, b) => a.ordinal - b.ordinal)
    const renderedBlocks: TranscriptBlock[] = []
    for (const b of mblocks) {
      renderedBlocks.push(await renderBlock(bundle, b, maxInlineBytes))
    }

    const mcalls = (callsByMessage.get(m.message_id) ?? []).sort((a, b) => {
      const ta = a.timestamp_start ?? ''
      const tb = b.timestamp_start ?? ''
      if (ta !== tb) return ta < tb ? -1 : 1
      return a.tool_call_id < b.tool_call_id ? -1 : a.tool_call_id > b.tool_call_id ? 1 : 0
    })
    const renderedCalls: TranscriptToolCall[] = []
    for (const c of mcalls) {
      renderedCalls.push(
        await renderToolCall(bundle, c, resultByCallId.get(c.tool_call_id) ?? null, maxArgsInlineBytes),
      )
    }

    turns.push({
      messageId: m.message_id,
      ordinal: m.ordinal,
      role: m.role as TranscriptTurn['role'],
      model: m.model,
      timestamp: m.timestamp,
      blocks: renderedBlocks,
      toolCalls: renderedCalls,
    })
  }

  const unattachedRendered: TranscriptToolCall[] = []
  for (const c of unattached) {
    unattachedRendered.push(
      await renderToolCall(bundle, c, resultByCallId.get(c.tool_call_id) ?? null, maxArgsInlineBytes),
    )
  }

  return { session, turns, unattachedToolCalls: unattachedRendered }
}

/**
 * Resolve a block's printable text. Returns null when neither inline nor CAS
 * has a body; returns null `text` (but keeps `textObjectId`) when the CAS
 * blob exceeds `maxInlineBytes` so renderers can fetch on demand.
 *
 * Exported so the markdown exporter can share the same resolution path.
 */
export async function resolveBlockText(
  bundle: Bundle,
  block: { text_inline: string | null; text_object_id: string | null },
  maxInlineBytes: number = DEFAULT_MAX_INLINE_BYTES,
): Promise<{ text: string | null; textObjectId: string | null; unavailable: boolean }> {
  if (block.text_inline != null) {
    return { text: block.text_inline, textObjectId: block.text_object_id, unavailable: false }
  }
  if (block.text_object_id) {
    try {
      const resolved = await getText(bundle, block.text_object_id)
      if (Buffer.byteLength(resolved, 'utf8') > maxInlineBytes) {
        return { text: null, textObjectId: block.text_object_id, unavailable: false }
      }
      return { text: resolved, textObjectId: block.text_object_id, unavailable: false }
    } catch {
      return { text: null, textObjectId: block.text_object_id, unavailable: true }
    }
  }
  return { text: null, textObjectId: null, unavailable: false }
}

/**
 * Resolve a tool call's args JSON. Returns null when the blob is missing or
 * exceeds `maxBytes`; the caller keeps the object id for "show full" UX.
 *
 * Exported so the markdown exporter can share the same resolution path.
 */
export async function resolveArgsText(
  bundle: Bundle,
  argsObjectId: ObjectId | null,
  maxBytes: number = DEFAULT_MAX_ARGS_INLINE_BYTES,
): Promise<string | null> {
  if (!argsObjectId) return null
  try {
    const text = await getText(bundle, argsObjectId)
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return null
    return text
  } catch {
    return null
  }
}

async function renderBlock(bundle: Bundle, b: BlockRow, maxInlineBytes: number): Promise<TranscriptBlock> {
  const resolved = await resolveBlockText(bundle, b, maxInlineBytes)
  // Surface CAS-fetch failure as an explicit marker so renderers can decide
  // whether to dim or annotate the block; we keep textObjectId for retry.
  const text = resolved.unavailable ? `[content unavailable: ${b.text_object_id}]` : resolved.text
  return {
    blockId: b.block_id,
    blockType: b.block_type,
    text,
    textObjectId: resolved.textObjectId,
    hidden: b.visibility === 'hidden_by_default',
    mimeType: b.mime_type,
    isError: b.is_error === 1,
  }
}

async function renderToolCall(
  bundle: Bundle,
  c: ToolCallRow,
  r: ToolResultRow | null,
  maxArgsInlineBytes: number,
): Promise<TranscriptToolCall> {
  const argsInline = await resolveArgsText(bundle, c.args_object_id, maxArgsInlineBytes)
  return {
    toolCallId: c.tool_call_id,
    toolName: c.tool_name,
    canonicalToolType: c.canonical_tool_type,
    argsInline,
    argsObjectId: c.args_object_id,
    command: c.command,
    path: c.path,
    status: c.status,
    timestampStart: c.timestamp_start,
    result: r
      ? {
          toolResultId: r.tool_result_id,
          status: r.status,
          isError: r.is_error === 1,
          exitCode: r.exit_code,
          durationMs: r.duration_ms,
          preview: r.preview,
          stdoutObjectId: r.stdout_object_id,
          stderrObjectId: r.stderr_object_id,
          outputObjectId: r.output_object_id,
        }
      : null,
  }
}
