// Lane 6 — `POST /v2/reads/sessions/transcript` handler.
//
// Paginated transcript reconstruction. The lane doc calls this a
// *heavy* read because the server has to join four projections
// (`projection_message`, `projection_content_block`,
// `projection_tool_call`, `projection_tool_result`) and every join
// has to compose the verified-projection gate so a single superseded
// row stays invisible.
//
// Page strategy:
//
//   1. Resolve the session header. If the session is not visible
//      under current authority for the caller, return `null` — never
//      a partial page.
//   2. Fetch the next page of messages. The cursor encodes the
//      stable `(ord, message_id)` tuple, where `ord` is a
//      `row_number()` over `(timestamp, message_id)` so a fresh page
//      iteration is reproducible even when the projection grows at
//      the head.
//   3. Fetch content blocks for that page's messages. Bodies larger
//      than 8 KiB defer to `artifacts.getText` — the page payload
//      stays bounded regardless of message size.
//   4. Fetch tool calls for that page's turns and the latest tool
//      result for each call.
//
// Tool calls that have no `turn_id` ("unattached") are surfaced once
// on the first page so the renderer can show them without
// duplicating them on every subsequent page.

import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import {
  type AuthoritySnapshot,
  InvalidCursorError,
  decodeRequiredCursor,
  encodeCursorSnapshot,
  encodeSignedCursor,
  parseCursorSnapshot,
  resolveAuthoritySnapshot,
  verifiedProjectionInSnapshotWhere,
} from '../shared/authority-snapshot.js'
import type { CursorSigner } from '../shared/cursor-signer.js'
import { appendParam } from './filters.js'

/**
 * Maximum UTF-8 byte size returned inline for a content block's
 * text. Larger bodies stay in CAS so the page payload stays bounded.
 */
export const INLINE_TEXT_BUDGET_BYTES = 8 * 1024

export const transcriptPageInput = z.object({
  sessionId: z.string().min(1),
  cursor: z.string().optional().nullable(),
  limit: z.number().int().min(1).max(200).default(50),
})

export type TranscriptPageInput = z.infer<typeof transcriptPageInput>

export type TranscriptBlock = {
  blockId: string
  blockType: string
  ordinal: number
  textInline: string | null
  textObjectId: string | null
  hidden: boolean
  isError: boolean
  isRedacted: boolean
  mimeType: string | null
}

export type TranscriptToolResult = {
  toolResultId: string
  status: string | null
  isError: boolean
  exitCode: number | null
  durationMs: number | null
}

export type TranscriptToolCall = {
  toolCallId: string
  toolName: string
  canonicalToolType: string | null
  status: string | null
  timestampStart: string | null
  result: TranscriptToolResult | null
}

export type TranscriptTurn = {
  messageId: string
  ordinal: number
  turnId: string | null
  role: string
  model: string | null
  timestamp: string | null
  blocks: TranscriptBlock[]
  toolCalls: TranscriptToolCall[]
}

export type TranscriptPageResponse = {
  session: {
    id: string
    sourceTool: string
    sourceSessionId: string
    title: string | null
    startedAt: string | null
    endedAt: string | null
    durationMs: number | null
    storeId: string
    receiptId: string
  }
  turns: TranscriptTurn[]
  unattachedToolCalls: TranscriptToolCall[]
  nextCursor: string | null
} | null

type SessionHeaderRow = {
  session_id: string
  source_tool: string
  source_session_id: string
  title: string | null
  start_ts: string | null
  end_ts: string | null
  store_id: string
  receipt_id: string
}

type MessageRow = {
  message_id: string
  turn_id: string | null
  role: string
  model: string | null
  timestamp: string | null
  ord: number
}

type BlockRow = {
  block_id: string
  message_id: string | null
  ordinal: number
  block_type: string
  is_error: boolean
  is_redacted: boolean
  visibility: string
  text_inline: string | null
  object_id: string | null
  payload: unknown
}

type ToolCallRow = {
  tool_call_id: string
  session_id: string
  store_id: string
  receipt_id: string
  turn_id: string | null
  tool_name: string
  canonical_tool_type: string | null
  timestamp_start: string | null
  status: string | null
}

type ToolResultRow = {
  tool_call_id: string
  session_id: string
  store_id: string
  receipt_id: string
  tool_result_id: string
  status: string | null
  is_error: boolean
  exit_code: number | null
  duration_ms: number | null
}

type StoredCursor = {
  ord: number
  id: string
  snapshot: Array<{ s: string; r: string }>
}

export type TranscriptDeps = {
  rawExec: RawExec
  cursorSigner: CursorSigner
}

export async function getTranscriptPage(
  deps: TranscriptDeps,
  tenantId: string,
  input: TranscriptPageInput,
): Promise<TranscriptPageResponse> {
  // CQ-142: pin the (store_id, receipt_id) snapshot at page 1 so
  // every subsequent page sees the same set, even if a fresh
  // promotion bumps `remote_authority_v2` mid-iteration.
  let snapshot: AuthoritySnapshot
  let cursor: { ord: number; id: string } | null = null
  const parsedCursor = decodeRequiredCursor<StoredCursor>(deps.cursorSigner, input.cursor ?? undefined)
  if (parsedCursor) {
    if (typeof parsedCursor.id !== 'string' || parsedCursor.id.length === 0) {
      throw new InvalidCursorError('cursor.id missing')
    }
    if (!Number.isInteger(parsedCursor.ord)) {
      throw new InvalidCursorError('cursor.ord must be an integer')
    }
    snapshot = parseCursorSnapshot(parsedCursor.snapshot)
    cursor = { ord: parsedCursor.ord, id: parsedCursor.id }
  } else {
    snapshot = await resolveAuthoritySnapshot(deps.rawExec, tenantId)
  }

  // Step 1: session header — gated by the pinned snapshot so a
  // session that was visible on page 1 stays visible on the
  // transcript pages even if its receipt was superseded mid-read.
  const headerParams: unknown[] = [tenantId, input.sessionId]
  const headerGate = verifiedProjectionInSnapshotWhere('s', '$1', snapshot, headerParams)
  const headerRows = await deps.rawExec<SessionHeaderRow>(
    `SELECT s.session_id, s.source_tool, s.source_session_id, s.title,
            to_char(s.start_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_ts,
            to_char(s.end_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_ts,
            s.store_id, s.receipt_id
       FROM projection_session s
      WHERE ${headerGate}
        AND s.session_id = $2
      LIMIT 1`,
    headerParams,
  )
  const header = headerRows[0]
  if (!header) return null

  // Step 2: page of messages with derived ordinal.
  const msgParams: unknown[] = [tenantId, input.sessionId]
  const msgGate = verifiedProjectionInSnapshotWhere('m', '$1', snapshot, msgParams)
  let cursorClause = ''
  if (cursor) {
    const ordParam = appendParam(msgParams, cursor.ord)
    const idParam = appendParam(msgParams, cursor.id)
    cursorClause = ` AND (ranked.ord > ${ordParam} OR (ranked.ord = ${ordParam} AND ranked.message_id > ${idParam}))`
  }
  const fetchLimit = input.limit + 1
  const limitParam = appendParam(msgParams, fetchLimit)

  const messages = await deps.rawExec<MessageRow>(
    `SELECT ranked.message_id, ranked.turn_id, ranked.role, ranked.model,
            to_char(ranked.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
            ranked.ord
       FROM (
         SELECT m.message_id, m.turn_id, m.role, m.model, m.timestamp,
                row_number() OVER (ORDER BY COALESCE(m.timestamp, '1970-01-01'::timestamptz), m.message_id)::int AS ord
           FROM projection_message m
          WHERE ${msgGate}
            AND m.session_id = $2
       ) ranked
      WHERE 1 = 1${cursorClause}
      ORDER BY ranked.ord ASC, ranked.message_id ASC
      LIMIT ${limitParam}`,
    msgParams,
  )

  const overflow = messages.length > input.limit
  const pageMessages = overflow ? messages.slice(0, input.limit) : messages
  const lastMsg = pageMessages[pageMessages.length - 1]
  const nextCursor =
    overflow && lastMsg
      ? encodeSignedCursor(deps.cursorSigner, {
          ord: lastMsg.ord,
          id: lastMsg.message_id,
          snapshot: encodeCursorSnapshot(snapshot),
        })
      : null

  const messageIds = pageMessages.map((m) => m.message_id)
  const turnIds: string[] = []
  for (const m of pageMessages) if (m.turn_id) turnIds.push(m.turn_id)

  // Step 3: blocks for the page's messages.
  let blocks: BlockRow[] = []
  if (messageIds.length > 0) {
    const blockParams: unknown[] = [tenantId]
    const gate = verifiedProjectionInSnapshotWhere('b', '$1', snapshot, blockParams)
    const placeholders = messageIds.map((id) => appendParam(blockParams, id)).join(', ')
    blocks = await deps.rawExec<BlockRow>(
      `SELECT b.block_id, b.message_id, b.ordinal, b.block_type, b.is_error, b.is_redacted, b.visibility,
              b.text_inline, b.object_id, b.payload
         FROM projection_content_block b
        WHERE ${gate}
          AND b.message_id IN (${placeholders})
        ORDER BY b.message_id ASC, b.ordinal ASC, b.block_id ASC`,
      blockParams,
    )
  }

  // Step 4a: tool calls attached to one of the page's turns.
  let turnCalls: ToolCallRow[] = []
  if (turnIds.length > 0) {
    const callParams: unknown[] = [tenantId, input.sessionId]
    const gate = verifiedProjectionInSnapshotWhere('c', '$1', snapshot, callParams)
    const placeholders = turnIds.map((id) => appendParam(callParams, id)).join(', ')
    turnCalls = await deps.rawExec<ToolCallRow>(
      `SELECT c.tool_call_id, c.session_id, c.store_id, c.receipt_id,
              c.turn_id, c.tool_name, c.canonical_tool_type,
              to_char(c.timestamp_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp_start,
              c.status
         FROM projection_tool_call c
        WHERE ${gate}
          AND c.session_id = $2
          AND c.turn_id IN (${placeholders})
        ORDER BY c.timestamp_start ASC NULLS LAST, c.tool_call_id ASC`,
      callParams,
    )
  }

  // Step 4b: unattached tool calls — only on the first page.
  let unattachedCalls: ToolCallRow[] = []
  if (!cursor) {
    const unattachedParams: unknown[] = [tenantId, input.sessionId]
    const gate = verifiedProjectionInSnapshotWhere('c', '$1', snapshot, unattachedParams)
    unattachedCalls = await deps.rawExec<ToolCallRow>(
      `SELECT c.tool_call_id, c.session_id, c.store_id, c.receipt_id,
              c.turn_id, c.tool_name, c.canonical_tool_type,
              to_char(c.timestamp_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp_start,
              c.status
         FROM projection_tool_call c
        WHERE ${gate}
          AND c.session_id = $2
          AND c.turn_id IS NULL
        ORDER BY c.timestamp_start ASC NULLS LAST, c.tool_call_id ASC`,
      unattachedParams,
    )
  }

  // Step 4c: latest tool result per call across both groups.
  const calls = [...turnCalls, ...unattachedCalls]
  const resultByCallTuple = new Map<string, ToolResultRow>()
  if (calls.length > 0) {
    const rParams: unknown[] = [tenantId]
    const gate = verifiedProjectionInSnapshotWhere('r', '$1', snapshot, rParams)
    const tuples = calls
      .map((c) => {
        const toolCallId = appendParam(rParams, c.tool_call_id)
        const sessionId = appendParam(rParams, c.session_id)
        const storeId = appendParam(rParams, c.store_id)
        const receiptId = appendParam(rParams, c.receipt_id)
        return `(${toolCallId}, ${sessionId}, ${storeId}, ${receiptId})`
      })
      .join(', ')
    const rows = await deps.rawExec<ToolResultRow>(
      `WITH visible_calls(tool_call_id, session_id, store_id, receipt_id) AS (
         VALUES ${tuples}
       )
       SELECT DISTINCT ON (r.tool_call_id, r.session_id, r.store_id, r.receipt_id)
              r.tool_call_id, r.session_id, r.store_id, r.receipt_id,
              r.tool_result_id, r.status, r.is_error, r.exit_code, r.duration_ms
         FROM projection_tool_result r
         JOIN visible_calls c
           ON c.tool_call_id = r.tool_call_id
          AND c.session_id = r.session_id
          AND c.store_id = r.store_id
          AND c.receipt_id = r.receipt_id
        WHERE ${gate}
        ORDER BY r.tool_call_id, r.session_id, r.store_id, r.receipt_id, r.tool_result_id DESC`,
      rParams,
    )
    for (const r of rows) resultByCallTuple.set(toolCallTupleKey(r), r)
  }

  // Assemble.
  const blocksByMessage = new Map<string, BlockRow[]>()
  for (const b of blocks) {
    if (!b.message_id) continue
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

  const seenTurnIds = new Set<string>()
  const turns: TranscriptTurn[] = pageMessages.map((m) => {
    const turnId = m.turn_id ?? null
    const callsForTurn = turnId && !seenTurnIds.has(turnId) ? (callsByTurn.get(turnId) ?? []) : []
    if (turnId) seenTurnIds.add(turnId)
    return {
      messageId: m.message_id,
      ordinal: m.ord,
      turnId,
      role: m.role,
      model: m.model,
      timestamp: m.timestamp,
      blocks: (blocksByMessage.get(m.message_id) ?? []).map(mapBlock),
      toolCalls: callsForTurn.map((c) => mapToolCall(c, resultByCallTuple.get(toolCallTupleKey(c)) ?? null)),
    }
  })

  const unattached = unattachedCalls.map((c) => mapToolCall(c, resultByCallTuple.get(toolCallTupleKey(c)) ?? null))

  return {
    session: {
      id: header.session_id,
      sourceTool: header.source_tool,
      sourceSessionId: header.source_session_id,
      title: header.title,
      startedAt: header.start_ts,
      endedAt: header.end_ts,
      durationMs:
        header.start_ts && header.end_ts ? Math.max(0, Date.parse(header.end_ts) - Date.parse(header.start_ts)) : null,
      storeId: header.store_id,
      receiptId: header.receipt_id,
    },
    turns,
    unattachedToolCalls: unattached,
    nextCursor,
  }
}

function toolCallTupleKey(row: {
  tool_call_id: string
  session_id: string
  store_id: string
  receipt_id: string
}): string {
  return `${row.tool_call_id}\0${row.session_id}\0${row.store_id}\0${row.receipt_id}`
}

function mapBlock(row: BlockRow): TranscriptBlock {
  const text = row.text_inline ?? null
  // Even if the row carries a body, anything past the inline budget
  // is surfaced via the CAS object id only.
  const inlineWithinBudget = text != null && Buffer.byteLength(text, 'utf8') <= INLINE_TEXT_BUDGET_BYTES ? text : null
  const meta = readPayload(row.payload)
  return {
    blockId: row.block_id,
    blockType: row.block_type,
    ordinal: row.ordinal,
    textInline: inlineWithinBudget,
    textObjectId: row.object_id ?? null,
    hidden: row.visibility !== 'visible' && row.visibility !== '',
    isError: row.is_error,
    isRedacted: row.is_redacted,
    mimeType: readString(meta, 'mimeType'),
  }
}

function mapToolCall(row: ToolCallRow, result: ToolResultRow | null): TranscriptToolCall {
  return {
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    canonicalToolType: row.canonical_tool_type,
    status: row.status,
    timestampStart: row.timestamp_start,
    result: result
      ? {
          toolResultId: result.tool_result_id,
          status: result.status,
          isError: result.is_error,
          exitCode: result.exit_code,
          durationMs: result.duration_ms,
        }
      : null,
  }
}

function readPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function readString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key]
  return typeof v === 'string' ? v : null
}
