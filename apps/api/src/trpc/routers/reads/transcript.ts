import { z } from 'zod'
import { tenantProcedure } from '../../init.js'
import {
  appendParam,
  decodeCursor,
  encodeCursor,
  tenantVerifiedProjectionSql,
  verifiedProjectionExistsSql,
} from './shared.js'

/**
 * Maximum UTF-8 byte size returned inline for a content block's text. Larger
 * bodies stay in CAS so the web can fetch via `artifacts.getText` on demand
 * to keep the page payload bounded.
 */
const INLINE_TEXT_BUDGET_BYTES = 8 * 1024

export const transcriptInput = z.object({
  sessionId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /**
   * Hint to clients that the caller wants thinking blocks rendered. The server
   * always includes hidden blocks (renderer decides); this is a metadata flag
   * the client can echo to control its own UI.
   */
  showThinking: z.boolean().default(false),
})

type TranscriptCursor = { o: number; id: string }

type SessionHeaderRow = {
  id: string
  source_kind: string
  title: string | null
  started_at: string | null
  ended_at: string | null
  turn_count: number
  metadata: unknown
}

type MessageRow = {
  id: string
  turn_id: string | null
  role: string
  model: string | null
  created_at: string | null
  /** Computed ordinal: row_number() over (order by created_at, id). */
  ordinal: number
}

type BlockRow = {
  id: string
  message_id: string
  sequence: number
  kind: string
  text: string | null
  object_id: string | null
  metadata: unknown
}

type ToolCallRow = {
  id: string
  turn_id: string | null
  name: string
  status: string | null
  input_object_id: string | null
  created_at: string | null
}

type ToolResultRow = {
  id: string
  tool_call_id: string
  output_object_id: string | null
  status: string | null
  finished_at: string | null
}

type RemoteTranscriptBlock = {
  blockId: string
  blockType: string
  /** Inline text when small (≤ 8KB). Larger bodies live in CAS. */
  textInline: string | null
  /** CAS id for lazy fetch via `artifacts.getText`. */
  textObjectId: string | null
  hidden: boolean
  isError: boolean
  mimeType: string | null
}

type RemoteTranscriptToolResult = {
  toolResultId: string
  status: string | null
  isError: boolean
  exitCode: number | null
  durationMs: number | null
  preview: string | null
  stdoutObjectId: string | null
  stderrObjectId: string | null
  outputObjectId: string | null
}

type RemoteTranscriptToolCall = {
  toolCallId: string
  toolName: string
  canonicalToolType: string | null
  argsInline: string | null
  argsObjectId: string | null
  command: string | null
  path: string | null
  status: string | null
  timestampStart: string | null
  result: RemoteTranscriptToolResult | null
}

type RemoteTranscriptTurn = {
  messageId: string
  ordinal: number
  role: string
  model: string | null
  timestamp: string | null
  blocks: RemoteTranscriptBlock[]
  toolCalls: RemoteTranscriptToolCall[]
}

export type RemoteTranscriptPage = {
  session: {
    id: string
    sourceKind: string
    title: string | null
    startedAt: string | null
    endedAt: string | null
    durationMs: number | null
    messageCount: number
    toolCallCount: number
    errorCount: number
    metadata: unknown
  }
  turns: RemoteTranscriptTurn[]
  nextCursor: string | null
  unattachedToolCalls: RemoteTranscriptToolCall[]
} | null

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key]
  return typeof v === 'string' ? v : null
}

function metaBool(meta: Record<string, unknown>, key: string): boolean {
  return meta[key] === true
}

function mapBlock(row: BlockRow): RemoteTranscriptBlock {
  const meta = readMetadata(row.metadata)
  const textBytes = row.text != null ? Buffer.byteLength(row.text, 'utf8') : 0
  const inline = row.text != null && textBytes <= INLINE_TEXT_BUDGET_BYTES ? row.text : null
  return {
    blockId: row.id,
    blockType: row.kind,
    textInline: inline,
    // Always carry the CAS id when present so the web can offer "Show full".
    textObjectId: row.object_id ?? null,
    hidden: metaString(meta, 'visibility') === 'hidden_by_default',
    isError: metaBool(meta, 'isError'),
    mimeType: metaString(meta, 'mimeType'),
  }
}

function mapToolCall(row: ToolCallRow, result: ToolResultRow | null): RemoteTranscriptToolCall {
  return {
    toolCallId: row.id,
    toolName: row.name,
    // The slim remote projection does not yet promote canonical tool type or
    // command/path. They are surfaced as nulls so the client renders gracefully
    // and the local CLI keeps the richer view for power users.
    canonicalToolType: null,
    argsInline: null,
    argsObjectId: row.input_object_id ?? null,
    command: null,
    path: null,
    status: row.status,
    timestampStart: row.created_at,
    result: result
      ? {
          toolResultId: result.id,
          status: result.status,
          isError: result.status != null && ['error', 'failed', 'failure'].includes(result.status.toLowerCase()),
          exitCode: null,
          durationMs:
            row.created_at && result.finished_at
              ? Math.max(0, Date.parse(result.finished_at) - Date.parse(row.created_at))
              : null,
          preview: null,
          stdoutObjectId: null,
          stderrObjectId: null,
          outputObjectId: result.output_object_id ?? null,
        }
      : null,
  }
}

export const transcriptProcedure = tenantProcedure.input(transcriptInput).query(async ({ ctx, input }) => {
  // Session header — must be verified at the session manifest layer or we
  // fail-closed by returning null.
  const sessionRows = await ctx.rawExec<SessionHeaderRow>(
    `SELECT p.id,
            p.source_kind,
            p.title,
            to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
            to_char(p.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_at,
            p.turn_count,
            p.metadata
       FROM "projection_session" p
      WHERE ${tenantVerifiedProjectionSql('p', 'session')} AND p.id = $2
      LIMIT 1`,
    [ctx.tenantId, input.sessionId],
  )
  const sessionRow = sessionRows[0]
  if (!sessionRow) return null as RemoteTranscriptPage

  // Aggregate counts over verified manifest rows only. The helper aliases
  // the manifest table as `m`, so we use distinct outer aliases (`mm`, `cc`,
  // `tt`) to avoid shadowing inside the EXISTS subquery.
  const counts = await ctx.rawExec<{ message_count: number; tool_call_count: number; error_count: number }>(
    `SELECT
       (SELECT count(*)::int FROM "projection_message" mm
         WHERE mm.tenant_id = $1 AND mm.session_id = $2 AND ${verifiedProjectionExistsSql('mm', 'message')}) AS message_count,
       (SELECT count(*)::int FROM "projection_tool_call" cc
         WHERE cc.tenant_id = $1 AND cc.session_id = $2 AND ${verifiedProjectionExistsSql('cc', 'tool_call')}) AS tool_call_count,
       (SELECT count(*)::int FROM "projection_tool_call" cc
         WHERE cc.tenant_id = $1 AND cc.session_id = $2 AND ${verifiedProjectionExistsSql('cc', 'tool_call')}
           AND (lower(COALESCE(cc.status, '')) IN ('error','failed','failure')
                OR EXISTS (
                  SELECT 1 FROM "projection_tool_result" tt
                   WHERE tt.tenant_id = cc.tenant_id AND tt.tool_call_id = cc.id
                     AND ${verifiedProjectionExistsSql('tt', 'tool_result')}
                     AND lower(COALESCE(tt.status, '')) IN ('error','failed','failure')
                ))) AS error_count`,
    [ctx.tenantId, input.sessionId],
  )
  const aggregate = counts[0] ?? { message_count: 0, tool_call_count: 0, error_count: 0 }

  // Page over messages. The remote schema has no `ordinal` column; we derive
  // one from (created_at, id) so cursors are stable across pages. The
  // ordinal is what we encode in the cursor so it can also be reported back
  // to the client UI as a turn number.
  const cursor = decodeCursor<TranscriptCursor>(input.cursor)
  const params: unknown[] = [ctx.tenantId, input.sessionId]
  let cursorClause = ''
  if (cursor) {
    const ordParam = appendParam(params, cursor.o)
    const idParam = appendParam(params, cursor.id)
    cursorClause = ` AND (ord > ${ordParam} OR (ord = ${ordParam} AND id > ${idParam}))`
  }
  const limitParam = appendParam(params, input.limit + 1)
  // Use a non-`m` alias for the projection row so the helper's manifest alias
  // (`m`) inside EXISTS does not shadow it. The window function derives a
  // stable per-session ordinal from (created_at, id) for cursoring.
  const messageRows = await ctx.rawExec<MessageRow>(
    `SELECT id, turn_id, role, model,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            ord AS ordinal
       FROM (
         SELECT mr.id, mr.turn_id, mr.role, mr.model, mr.created_at,
                row_number() OVER (ORDER BY COALESCE(mr.created_at, '1970-01-01'), mr.id)::int AS ord
           FROM "projection_message" mr
          WHERE mr.tenant_id = $1 AND mr.session_id = $2
            AND ${verifiedProjectionExistsSql('mr', 'message')}
       ) ranked
      WHERE 1=1${cursorClause}
      ORDER BY ord ASC, id ASC
      LIMIT ${limitParam}`,
    params,
  )

  const overflow = messageRows.length > input.limit
  const pageMessages = overflow ? messageRows.slice(0, input.limit) : messageRows
  const lastMessage = pageMessages[pageMessages.length - 1]
  const nextCursor = overflow && lastMessage ? encodeCursor({ o: lastMessage.ordinal, id: lastMessage.id }) : null

  const messageIds = pageMessages.map((m) => m.id)
  const turnIds = pageMessages.map((m) => m.turn_id).filter((id): id is string => id != null)

  // Blocks for the page's messages, in (message_id, sequence) order. Skip the
  // round-trip when the page is empty. Inline placeholders are safer here than
  // array params — the runtime (PGlite in tests) does not uniformly support
  // `ANY($n::text[])`.
  // The helper aliases `sync_batch` as `b`; we use `cb` here so the outer
  // and inner namespaces do not collide.
  let blocks: BlockRow[] = []
  if (messageIds.length > 0) {
    const blockParams: unknown[] = [ctx.tenantId]
    const placeholders = messageIds.map((id) => appendParam(blockParams, id)).join(', ')
    blocks = await ctx.rawExec<BlockRow>(
      `SELECT cb.id, cb.message_id, cb.sequence, cb.kind, cb.text, cb.object_id, cb.metadata
         FROM "projection_content_block" cb
        WHERE cb.tenant_id = $1 AND cb.message_id IN (${placeholders})
          AND ${verifiedProjectionExistsSql('cb', 'content_block')}
        ORDER BY cb.message_id, cb.sequence, cb.id`,
      blockParams,
    )
  }

  // Tool calls attached to a turn that appears in this page. The slim remote
  // schema does not store `message_id` on tool_call, so we group by turn_id.
  // Calls without a turn_id surface in `unattachedToolCalls` on the first page.
  let turnCalls: ToolCallRow[] = []
  if (turnIds.length > 0) {
    const callParams: unknown[] = [ctx.tenantId, input.sessionId]
    const placeholders = turnIds.map((id) => appendParam(callParams, id)).join(', ')
    turnCalls = await ctx.rawExec<ToolCallRow>(
      `SELECT c.id, c.turn_id, c.name, c.status, c.input_object_id,
              to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM "projection_tool_call" c
        WHERE c.tenant_id = $1 AND c.session_id = $2 AND c.turn_id IN (${placeholders})
          AND ${verifiedProjectionExistsSql('c', 'tool_call')}
        ORDER BY c.created_at ASC NULLS LAST, c.id ASC`,
      callParams,
    )
  }

  const unattachedCalls = !cursor // only on first page
    ? await ctx.rawExec<ToolCallRow>(
        `SELECT c.id, c.turn_id, c.name, c.status, c.input_object_id,
                  to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
             FROM "projection_tool_call" c
            WHERE c.tenant_id = $1 AND c.session_id = $2 AND c.turn_id IS NULL
              AND ${verifiedProjectionExistsSql('c', 'tool_call')}
            ORDER BY c.created_at ASC NULLS LAST, c.id ASC`,
        [ctx.tenantId, input.sessionId],
      )
    : []

  const callIds = [...turnCalls, ...unattachedCalls].map((c) => c.id)
  // Latest tool result per call (mirrors the sessions/tool-calls join shape).
  let results: ToolResultRow[] = []
  if (callIds.length > 0) {
    const resultParams: unknown[] = [ctx.tenantId]
    const placeholders = callIds.map((id) => appendParam(resultParams, id)).join(', ')
    results = await ctx.rawExec<ToolResultRow>(
      `SELECT DISTINCT ON (tr.tool_call_id)
              tr.id, tr.tool_call_id, tr.output_object_id, tr.status,
              to_char(tr.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at
         FROM "projection_tool_result" tr
        WHERE tr.tenant_id = $1 AND tr.tool_call_id IN (${placeholders})
          AND ${verifiedProjectionExistsSql('tr', 'tool_result')}
        ORDER BY tr.tool_call_id, tr.finished_at DESC NULLS LAST, tr.id DESC`,
      resultParams,
    )
  }
  const resultByCallId = new Map<string, ToolResultRow>(results.map((r) => [r.tool_call_id, r]))

  const blocksByMessage = new Map<string, BlockRow[]>()
  for (const b of blocks) {
    const list = blocksByMessage.get(b.message_id) ?? []
    list.push(b)
    blocksByMessage.set(b.message_id, list)
  }
  const callsByTurn = new Map<string, ToolCallRow[]>()
  for (const c of turnCalls) {
    if (c.turn_id == null) continue
    const list = callsByTurn.get(c.turn_id) ?? []
    list.push(c)
    callsByTurn.set(c.turn_id, list)
  }

  const turns: RemoteTranscriptTurn[] = pageMessages.map((m) => ({
    messageId: m.id,
    ordinal: m.ordinal,
    role: m.role,
    model: m.model,
    timestamp: m.created_at,
    blocks: (blocksByMessage.get(m.id) ?? []).map(mapBlock),
    // Attach tool calls that share this message's turn_id. When the same turn
    // holds multiple assistant messages we duplicate the tool calls — the
    // slim remote schema does not carry message-level attribution. The
    // client renders them inside the first assistant turn for that turn id.
    toolCalls: m.turn_id
      ? (callsByTurn.get(m.turn_id) ?? []).map((c) => mapToolCall(c, resultByCallId.get(c.id) ?? null))
      : [],
  }))

  // De-duplicate tool calls so a turn that already rendered them does not see
  // them repeated across same-turn sibling messages. The first message in turn
  // order keeps the calls; later same-turn messages drop them.
  const seenTurnIds = new Set<string>()
  for (const turn of turns) {
    const msg = pageMessages.find((m) => m.id === turn.messageId)
    const turnId = msg?.turn_id ?? null
    if (turnId && seenTurnIds.has(turnId)) {
      turn.toolCalls = []
    } else if (turnId) {
      seenTurnIds.add(turnId)
    }
  }

  const unattachedToolCalls: RemoteTranscriptToolCall[] = unattachedCalls.map((c) =>
    mapToolCall(c, resultByCallId.get(c.id) ?? null),
  )

  const page: NonNullable<RemoteTranscriptPage> = {
    session: {
      id: sessionRow.id,
      sourceKind: sessionRow.source_kind,
      title: sessionRow.title,
      startedAt: sessionRow.started_at,
      endedAt: sessionRow.ended_at,
      durationMs:
        sessionRow.started_at && sessionRow.ended_at
          ? Math.max(0, Date.parse(sessionRow.ended_at) - Date.parse(sessionRow.started_at))
          : null,
      messageCount: aggregate.message_count,
      toolCallCount: aggregate.tool_call_count,
      errorCount: aggregate.error_count,
      metadata: sessionRow.metadata,
    },
    turns,
    nextCursor,
    unattachedToolCalls,
  }
  return page
})
