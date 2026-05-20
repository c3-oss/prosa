// Lane 7 — `prosa read tool-calls`.
//
// Consumes `/v2/reads/tool-calls/list`. The local fallback is
// intentionally omitted for this slice: the audit view requires
// receipt-pinned authority semantics that the local bundle cannot
// reproduce. Local callers should use `prosa read transcript` plus
// `prosa export session` for ad-hoc inspection until Lane 8 adds
// a local audit surface.

import { Command } from 'commander'
import { type ColumnSet, maxWidthsForColumns, resolveColumns, tailColumnsFor } from '../../../columns.js'
import { CliUserError } from '../../../errors.js'
import { printRows } from '../../../output.js'
import {
  type CommonReadOptions,
  addCommonReadOptions,
  parseOutputFormat,
  prepareV2Read,
  with412Retry,
} from './common.js'

type ToolCallCol =
  | 'started_at'
  | 'tool_name'
  | 'session_id'
  | 'status'
  | 'result_status'
  | 'summary'
  | 'store_id'
  | 'receipt_id'

const TOOL_CALL_COLUMNS: ColumnSet<ToolCallCol> = {
  default: ['started_at', 'tool_name', 'session_id', 'status', 'result_status', 'summary'],
  all: ['started_at', 'tool_name', 'session_id', 'status', 'result_status', 'summary', 'store_id', 'receipt_id'],
  maxWidths: {
    session_id: 14,
    summary: 80,
    store_id: 14,
    receipt_id: 14,
  },
  tail: new Set(),
}

type ToolCallsOptions = CommonReadOptions & {
  source?: string
  toolName?: string
  session?: string
  errorsOnly: boolean
  since?: string
  until?: string
  limit: string
  cursor?: string
  outputFormat: string
  columns?: string
}

export function readToolCallsCommand(): Command {
  const cmd = new Command('tool-calls').description('Audit tool calls via the receipt-pinned v2 read API.')
  addCommonReadOptions(cmd)
  cmd
    .option('--source <tool>', 'filter by source tool')
    .option('--tool-name <name>', 'filter by tool name')
    .option('--session <id>', 'filter by session id')
    .option('--errors-only', 'only return calls whose result status is error', false)
    .option('--since <iso>', 'calls started on/after this ISO timestamp')
    .option('--until <iso>', 'calls started before this ISO timestamp')
    .option('--limit <n>', 'maximum rows per page', '50')
    .option('--cursor <token>', 'opaque page cursor from a prior response')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .option(
      '--columns <list>',
      `comma-separated columns to show (or 'default'|'all'); available: ${TOOL_CALL_COLUMNS.all.join(', ')}`,
    )
    .action(async (options: ToolCallsOptions) => {
      const format = parseOutputFormat(options.outputFormat, 'table')
      const columns = resolveColumns(TOOL_CALL_COLUMNS, options.columns)
      const limit = Number.parseInt(options.limit, 10)
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new CliUserError(`invalid --limit: ${options.limit}`)
      }

      const ctx = await prepareV2Read({ commandName: 'prosa read tool-calls', options })

      if (ctx.kind === 'local') {
        throw new CliUserError(
          'prosa read tool-calls requires a remote-promoted store; this command is unavailable in --authority local.',
        )
      }

      const response = await with412Retry(ctx, (cur) => {
        if (cur.kind !== 'remote') throw new Error('expected remote context')
        return cur.client.listToolCalls({
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.source ? { sourceTools: [options.source] } : {}),
          ...(options.toolName ? { toolNames: [options.toolName] } : {}),
          ...(options.session ? { sessionIds: [options.session] } : {}),
          ...(options.errorsOnly ? { errorsOnly: true } : {}),
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
        })
      })

      const shaped = response.rows.map((row) => ({
        started_at: row.startedAt,
        tool_name: row.toolName,
        session_id: row.sessionId,
        status: row.status,
        result_status: row.resultStatus,
        summary: row.summary,
        store_id: row.storeId,
        receipt_id: row.receiptId,
      }))

      printRows(shaped, {
        format,
        columns,
        maxColumnWidths: maxWidthsForColumns(TOOL_CALL_COLUMNS, columns),
        tailColumns: tailColumnsFor(TOOL_CALL_COLUMNS, columns),
        meta: {
          source: 'remote',
          server: ctx.entry.url,
          storeId: ctx.storeId,
          receiptId: ctx.authority.receiptId,
          auditStatus: ctx.authority.auditStatus,
          nextCursor: response.nextCursor,
        },
      })
    })
  return cmd
}
