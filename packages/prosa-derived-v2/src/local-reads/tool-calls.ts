// Local-bundle implementation of `prosa read tool-calls`.
//
// Streams `tool_call.prosa-projection.ndjson`, joins each row with
// the latest matching `tool_result` row by `tool_call_id`, and
// applies the limited filter set the CLI permits in local mode.

import { loadBundleHead } from './head.js'
import { collectProjectionRows } from './ndjson-stream.js'

export type LocalToolCallRow = {
  tool_call_id: string
  session_id: string | null
  source_call_id: string | null
  tool_name: string
  canonical_tool_type: string | null
  command: string | null
  cwd: string | null
  path: string | null
  query: string | null
  timestamp_start: string | null
  timestamp_end: string | null
  status: string | null
  is_error: boolean | null
  preview: string | null
  message_id: string | null
  event_id: string | null
}

export type ListToolCallsLocalOptions = {
  bundleRoot: string
  sessionId?: string | null
  toolNames?: string[]
  canonicalToolTypes?: string[]
  errorsOnly?: boolean
  sinceIso?: string | null
  untilIso?: string | null
  limit: number
}

function getString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Return up to `limit` tool_call rows for the bundle's current epoch,
 * sorted by `timestamp_start` descending. Each row is enriched with
 * the most-recent matching `tool_result` row's `status`, `is_error`,
 * and `preview` fields (lookup is by `tool_call_id`).
 */
export async function listToolCallsLocal(options: ListToolCallsLocalOptions): Promise<{
  rows: LocalToolCallRow[]
  epoch: number
}> {
  const head = await loadBundleHead(options.bundleRoot)
  const [toolCalls, toolResults] = await Promise.all([
    collectProjectionRows(options.bundleRoot, head.epoch, 'tool_call'),
    collectProjectionRows(options.bundleRoot, head.epoch, 'tool_result'),
  ])
  const resultsByCallId = new Map<string, Record<string, unknown>>()
  for (const r of toolResults) {
    const tcid = typeof r.tool_call_id === 'string' ? r.tool_call_id : null
    if (tcid !== null) resultsByCallId.set(tcid, r)
  }
  const toolNameFilter = options.toolNames && options.toolNames.length > 0 ? new Set(options.toolNames) : null
  const canonicalFilter =
    options.canonicalToolTypes && options.canonicalToolTypes.length > 0 ? new Set(options.canonicalToolTypes) : null
  const rows: LocalToolCallRow[] = []
  for (const row of toolCalls) {
    const callId = typeof row.tool_call_id === 'string' ? row.tool_call_id : ''
    if (callId.length === 0) continue
    const result = resultsByCallId.get(callId) ?? null
    const isError = result !== null && typeof result.is_error === 'boolean' ? result.is_error : null
    if (options.errorsOnly === true && isError !== true) continue
    if (options.sessionId && row.session_id !== options.sessionId) continue
    if (toolNameFilter !== null && !toolNameFilter.has(String(row.tool_name))) continue
    if (canonicalFilter !== null && !canonicalFilter.has(String(row.canonical_tool_type))) continue
    const tsStart = typeof row.timestamp_start === 'string' ? row.timestamp_start : null
    if (options.sinceIso && (tsStart === null || tsStart < options.sinceIso)) continue
    if (options.untilIso && (tsStart === null || tsStart >= options.untilIso)) continue
    rows.push({
      tool_call_id: callId,
      session_id: getString(row, 'session_id'),
      source_call_id: getString(row, 'source_call_id'),
      tool_name: typeof row.tool_name === 'string' ? row.tool_name : '',
      canonical_tool_type: getString(row, 'canonical_tool_type'),
      command: getString(row, 'command'),
      cwd: getString(row, 'cwd'),
      path: getString(row, 'path'),
      query: getString(row, 'query'),
      timestamp_start: tsStart,
      timestamp_end: getString(row, 'timestamp_end'),
      status: result === null ? getString(row, 'status') : getString(result, 'status'),
      is_error: isError,
      preview: result === null ? null : getString(result, 'preview'),
      message_id: getString(row, 'message_id'),
      event_id: getString(row, 'event_id'),
    })
  }
  rows.sort((a, b) => {
    const ax = a.timestamp_start ?? ''
    const bx = b.timestamp_start ?? ''
    if (ax === bx) return a.tool_call_id < b.tool_call_id ? 1 : a.tool_call_id > b.tool_call_id ? -1 : 0
    return ax < bx ? 1 : -1
  })
  return { rows: rows.slice(0, options.limit), epoch: head.epoch }
}
