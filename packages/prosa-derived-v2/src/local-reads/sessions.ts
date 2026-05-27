// Local-bundle implementation of `prosa read sessions [--count]`.
//
// Streams `session.prosa-projection.ndjson` for the bundle's current
// epoch, applies the limited filter set the CLI permits in local mode
// (source_tool / since / until), sorts by `start_ts` descending so
// the rows match the remote API contract, and returns a small row
// shape compatible with the CLI's existing column model.

import { loadBundleHead } from './head.js'
import { iterateProjectionRows } from './ndjson-stream.js'

export type LocalSessionRow = {
  start_ts: string | null
  end_ts: string | null
  source_tool: string | null
  session_id: string
  source_session_id: string | null
  parent_session_id: string | null
  is_subagent: boolean | null
  title: string | null
  cwd_initial: string | null
  git_branch_initial: string | null
  model_first: string | null
  model_last: string | null
  status: string | null
  timeline_confidence: string | null
  message_count: number | null
  tool_call_count: number | null
  project_id: string | null
  store_id: string | null
  receipt_id: string | null
}

export type ListSessionsLocalOptions = {
  bundleRoot: string
  sourceTool?: string | null
  sinceIso?: string | null
  untilIso?: string | null
  limit: number
}

export type CountSessionsLocalOptions = Omit<ListSessionsLocalOptions, 'limit'>

function getString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function passes(
  row: Record<string, unknown>,
  filters: { sourceTool?: string | null; sinceIso?: string | null; untilIso?: string | null },
): boolean {
  if (filters.sourceTool && row.source_tool !== filters.sourceTool) return false
  const startTs = typeof row.start_ts === 'string' ? row.start_ts : null
  if (filters.sinceIso && (startTs === null || startTs < filters.sinceIso)) return false
  if (filters.untilIso && (startTs === null || startTs >= filters.untilIso)) return false
  return true
}

/**
 * Return up to `limit` session rows for the bundle's current epoch,
 * sorted by `start_ts` descending (newest first). Cross-epoch
 * collapsing — which the remote API does via DISTINCT ON
 * `(source_tool, source_session_id)` — is out of scope for the
 * single-epoch local read; the projection writer already dedupes by
 * canonical `session_id`, which is what the remote API ultimately
 * indexes by.
 */
export async function listSessionsLocal(options: ListSessionsLocalOptions): Promise<{
  rows: LocalSessionRow[]
  totalScanned: number
  epoch: number
  storeId: string
}> {
  const head = await loadBundleHead(options.bundleRoot)
  const collected: LocalSessionRow[] = []
  let totalScanned = 0
  for await (const row of iterateProjectionRows(options.bundleRoot, head.epoch, 'session')) {
    totalScanned += 1
    if (!passes(row, options)) continue
    collected.push({
      start_ts: getString(row, 'start_ts'),
      end_ts: getString(row, 'end_ts'),
      source_tool: getString(row, 'source_tool'),
      session_id: typeof row.session_id === 'string' ? row.session_id : '',
      source_session_id: getString(row, 'source_session_id'),
      parent_session_id: getString(row, 'parent_session_id'),
      is_subagent: typeof row.is_subagent === 'boolean' ? row.is_subagent : null,
      title: getString(row, 'title'),
      cwd_initial: getString(row, 'cwd_initial'),
      git_branch_initial: getString(row, 'git_branch_initial'),
      model_first: getString(row, 'model_first'),
      model_last: getString(row, 'model_last'),
      status: getString(row, 'status'),
      timeline_confidence: getString(row, 'timeline_confidence'),
      message_count: null,
      tool_call_count: null,
      project_id: getString(row, 'project_id'),
      store_id: head.storeId,
      receipt_id: null,
    })
  }
  collected.sort((a, b) => {
    const aStart = a.start_ts ?? ''
    const bStart = b.start_ts ?? ''
    if (aStart === bStart) {
      return a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0
    }
    return aStart < bStart ? 1 : -1
  })
  return {
    rows: collected.slice(0, options.limit),
    totalScanned,
    epoch: head.epoch,
    storeId: head.storeId,
  }
}

/**
 * Count sessions in the bundle's current epoch that pass the same
 * filter set `listSessionsLocal` applies.
 */
export async function countSessionsLocal(options: CountSessionsLocalOptions): Promise<{
  count: number
  epoch: number
}> {
  const head = await loadBundleHead(options.bundleRoot)
  let count = 0
  for await (const row of iterateProjectionRows(options.bundleRoot, head.epoch, 'session')) {
    if (passes(row, options)) count += 1
  }
  return { count, epoch: head.epoch }
}
