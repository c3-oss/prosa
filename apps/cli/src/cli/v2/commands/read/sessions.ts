// Lane 7 — `prosa read sessions` and `prosa read sessions --count`.
//
// Consumes `/v2/reads/sessions/list` and `/v2/reads/sessions/count`
// for promoted stores. When the authority resolver returns `local`
// (no v2 promotion recorded), falls back to the local bundle via
// `prosa-core` so the command stays usable on un-promoted stores.

import { countSessions as countLocalSessions, listSessions as listLocalSessions } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { withBundle } from '../../../bundle.js'
import { type ColumnSet, maxWidthsForColumns, resolveColumns, tailColumnsFor } from '../../../columns.js'
import { CliUserError } from '../../../errors.js'
import { printRows } from '../../../output.js'
import { parseSourceTool } from '../../../parsers.js'
import {
  type CommonReadOptions,
  addCommonReadOptions,
  parseOutputFormat,
  prepareV2Read,
  with412RefreshAndRetry,
} from './common.js'

type SessionCol =
  | 'start_ts'
  | 'end_ts'
  | 'source_tool'
  | 'session_id'
  | 'source_session_id'
  | 'parent_session_id'
  | 'is_subagent'
  | 'title'
  | 'cwd_initial'
  | 'git_branch_initial'
  | 'model_first'
  | 'model_last'
  | 'status'
  | 'timeline_confidence'
  | 'message_count'
  | 'tool_call_count'
  | 'project_id'
  | 'store_id'
  | 'receipt_id'

const SESSION_COLUMNS: ColumnSet<SessionCol> = {
  default: ['start_ts', 'source_tool', 'session_id', 'title'],
  all: [
    'start_ts',
    'end_ts',
    'source_tool',
    'session_id',
    'source_session_id',
    'parent_session_id',
    'is_subagent',
    'title',
    'cwd_initial',
    'git_branch_initial',
    'model_first',
    'model_last',
    'status',
    'timeline_confidence',
    'message_count',
    'tool_call_count',
    'project_id',
    'store_id',
    'receipt_id',
  ],
  maxWidths: {
    session_id: 14,
    source_session_id: 12,
    parent_session_id: 12,
    title: 50,
    receipt_id: 14,
    store_id: 14,
  },
  tail: new Set(['cwd_initial']),
}

type SessionsOptions = CommonReadOptions & {
  source?: string
  project?: string
  since?: string
  until?: string
  limit: string
  cursor?: string
  outputFormat: string
  columns?: string
  count?: boolean
}

export function readSessionsCommand(): Command {
  const command = new Command('sessions').description('List sessions via the receipt-pinned v2 read API.')
  addCommonReadOptions(command)
  command
    .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini|hermes')
    .option('--project <id>', 'filter by project id')
    .option('--since <iso>', 'sessions starting on/after this ISO timestamp')
    .option('--until <iso>', 'sessions starting before this ISO timestamp')
    .option('--limit <n>', 'maximum rows per page', '50')
    .option('--cursor <token>', 'opaque page cursor from a prior response')
    .option('--count', 'print only the matching count, not the rows', false)
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .option(
      '--columns <list>',
      `comma-separated columns to show (or 'default'|'all'); available: ${SESSION_COLUMNS.all.join(', ')}`,
    )
    .action(async (options: SessionsOptions) => {
      if (options.count) {
        await runCount(options)
        return
      }
      await runList(options)
    })
  return command
}

async function runList(options: SessionsOptions): Promise<void> {
  const format = parseOutputFormat(options.outputFormat, 'table')
  const columns = resolveColumns(SESSION_COLUMNS, options.columns)
  const sourceTool = parseSourceTool(options.source)
  const limit = Number.parseInt(options.limit, 10)
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`invalid --limit: ${options.limit}`)
  }

  const ctx = await prepareV2Read({ commandName: 'prosa read sessions', options })

  if (ctx.kind === 'local') {
    rejectUnsupportedLocalFilters('prosa read sessions', options)
    await withBundle(ctx.storePath, (bundle) => {
      const rows = listLocalSessions(bundle, {
        sourceTool,
        sinceIso: options.since,
        untilIso: options.until,
        limit,
      })
      printRows(rows, {
        format,
        columns,
        maxColumnWidths: maxWidthsForColumns(SESSION_COLUMNS, columns),
        tailColumns: tailColumnsFor(SESSION_COLUMNS, columns),
        meta: { source: 'local', store: ctx.storePath },
      })
    })
    return
  }

  const response = await with412RefreshAndRetry(ctx, (cur) => {
    if (cur.kind !== 'remote') throw new Error('expected remote context')
    return cur.client.listSessions({
      limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(sourceTool ? { sourceTools: [sourceTool] } : {}),
      ...(options.project ? { projectIds: [options.project] } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.until ? { until: options.until } : {}),
    })
  })

  const shaped = response.rows.map((row) => ({
    start_ts: row.startedAt,
    end_ts: row.endedAt,
    source_tool: row.sourceTool,
    session_id: row.id,
    source_session_id: row.sourceSessionId,
    parent_session_id: row.parentSessionId,
    is_subagent: row.isSubagent,
    title: row.title,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: row.status,
    timeline_confidence: row.timelineConfidence,
    message_count: null,
    tool_call_count: null,
    project_id: row.projectId,
    store_id: row.storeId,
    receipt_id: row.receiptId,
  }))

  printRows(shaped, {
    format,
    columns,
    maxColumnWidths: maxWidthsForColumns(SESSION_COLUMNS, columns),
    tailColumns: tailColumnsFor(SESSION_COLUMNS, columns),
    meta: {
      source: 'remote',
      server: ctx.entry.url,
      storeId: ctx.storeId,
      receiptId: ctx.authority.receiptId,
      auditStatus: ctx.authority.auditStatus,
      nextCursor: response.nextCursor,
    },
  })
}

function rejectUnsupportedLocalFilters(commandName: string, options: SessionsOptions): void {
  const unsupported: string[] = []
  if (options.project) unsupported.push('--project')
  if (options.cursor) unsupported.push('--cursor')
  if (unsupported.length > 0) {
    throw new CliUserError(
      `${commandName} local mode does not support ${unsupported.join(', ')}; rerun against a promoted store with --authority remote, or drop the unsupported filter.`,
    )
  }
}

async function runCount(options: SessionsOptions): Promise<void> {
  const sourceTool = parseSourceTool(options.source)
  const ctx = await prepareV2Read({ commandName: 'prosa read sessions --count', options })

  if (ctx.kind === 'local') {
    rejectUnsupportedLocalFilters('prosa read sessions --count', { ...options, cursor: undefined })
    await withBundle(ctx.storePath, (bundle) => {
      const count = countLocalSessions(bundle, {
        sourceTool,
        sinceIso: options.since,
        untilIso: options.until,
      })
      process.stdout.write(`${count}\n`)
    })
    return
  }

  const response = await with412RefreshAndRetry(ctx, (cur) => {
    if (cur.kind !== 'remote') throw new Error('expected remote context')
    return cur.client.countSessions({
      ...(sourceTool ? { sourceTools: [sourceTool] } : {}),
      ...(options.project ? { projectIds: [options.project] } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.until ? { until: options.until } : {}),
    })
  })
  process.stdout.write(`${response.count}\n`)
}
