// Lane 7 — `prosa read tool-calls`.
//
// Consumes `/v2/reads/tool-calls/list`. Input + output shapes match
// the server route schema verbatim: `sessionId` (singular),
// `toolNames`, `canonicalToolTypes`, `errorsOnly`, `since`, `until`.
// Each hit carries `timestampStart` + `latestResult`; the CLI shows
// the result status alongside the call status when available.

import { listToolCallsLocal } from '@c3-oss/prosa-derived-v2'
import { Command } from 'commander'
import { type ColumnSet, maxWidthsForColumns, resolveColumns, tailColumnsFor } from '../../../columns.js'
import { CliUserError } from '../../../errors.js'
import { printRows } from '../../../output.js'
import {
  type CommonReadOptions,
  addCommonReadOptions,
  parseOutputFormat,
  prepareV2Read,
  with412RefreshAndRetry,
} from './common.js'

type ToolCallCol =
  | 'timestamp_start'
  | 'tool_name'
  | 'session_id'
  | 'turn_id'
  | 'canonical_tool_type'
  | 'status'
  | 'result_status'
  | 'result_is_error'
  | 'result_exit_code'
  | 'result_duration_ms'
  | 'store_id'
  | 'receipt_id'

const TOOL_CALL_COLUMNS: ColumnSet<ToolCallCol> = {
  default: ['timestamp_start', 'tool_name', 'session_id', 'status', 'result_status'],
  all: [
    'timestamp_start',
    'tool_name',
    'session_id',
    'turn_id',
    'canonical_tool_type',
    'status',
    'result_status',
    'result_is_error',
    'result_exit_code',
    'result_duration_ms',
    'store_id',
    'receipt_id',
  ],
  maxWidths: {
    session_id: 14,
    turn_id: 14,
    store_id: 14,
    receipt_id: 14,
  },
  tail: new Set(),
}

type ToolCallsOptions = CommonReadOptions & {
  session?: string
  toolName?: string[]
  canonicalToolType?: string[]
  errorsOnly: boolean
  since?: string
  until?: string
  limit: string
  cursor?: string
  outputFormat: string
  columns?: string
}

function collectArrayFlag(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value]
}

export function readToolCallsCommand(): Command {
  const cmd = new Command('tool-calls').description('Audit tool calls via the receipt-pinned v2 read API.')
  addCommonReadOptions(cmd)
  cmd
    .option('--session <id>', 'filter by session id')
    .option('--tool-name <name>', 'filter by tool name (repeatable)', collectArrayFlag)
    .option('--canonical-tool-type <type>', 'filter by canonical tool type (repeatable)', collectArrayFlag)
    .option('--errors-only', 'only return calls whose latest result is an error', false)
    .option('--since <iso>', 'lower bound on timestamp_start (inclusive)')
    .option('--until <iso>', 'upper bound on timestamp_start (exclusive)')
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
        if (options.cursor) {
          throw new CliUserError(
            'prosa read tool-calls local mode does not support --cursor; rerun against a promoted store with --authority remote, or drop the flag.',
          )
        }
        const result = await listToolCallsLocal({
          bundleRoot: ctx.storePath,
          sessionId: options.session ?? null,
          ...(options.toolName ? { toolNames: options.toolName } : {}),
          ...(options.canonicalToolType ? { canonicalToolTypes: options.canonicalToolType } : {}),
          errorsOnly: options.errorsOnly,
          sinceIso: options.since ?? null,
          untilIso: options.until ?? null,
          limit,
        })
        const shapedLocal = result.rows.map((row) => ({
          timestamp_start: row.timestamp_start,
          tool_name: row.tool_name,
          session_id: row.session_id,
          turn_id: null,
          canonical_tool_type: row.canonical_tool_type,
          status: row.status,
          result_status: row.status,
          result_is_error: row.is_error,
          result_exit_code: null,
          result_duration_ms: null,
          store_id: null,
          receipt_id: null,
        }))
        printRows(shapedLocal, {
          format,
          columns,
          maxColumnWidths: maxWidthsForColumns(TOOL_CALL_COLUMNS, columns),
          tailColumns: tailColumnsFor(TOOL_CALL_COLUMNS, columns),
          meta: { source: 'local', store: ctx.storePath, epoch: result.epoch },
        })
        return
      }

      const response = await with412RefreshAndRetry(ctx, (cur) => {
        if (cur.kind !== 'remote') throw new Error('expected remote context')
        return cur.client.listToolCalls({
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.session ? { sessionId: options.session } : {}),
          ...(options.toolName?.length ? { toolNames: options.toolName } : {}),
          ...(options.canonicalToolType?.length ? { canonicalToolTypes: options.canonicalToolType } : {}),
          ...(options.errorsOnly ? { errorsOnly: true } : {}),
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
        })
      })

      const shaped = response.rows.map((row) => ({
        timestamp_start: row.timestampStart,
        tool_name: row.toolName,
        session_id: row.sessionId,
        turn_id: row.turnId,
        canonical_tool_type: row.canonicalToolType,
        status: row.status,
        result_status: row.latestResult?.status ?? null,
        result_is_error: row.latestResult?.isError ?? null,
        result_exit_code: row.latestResult?.exitCode ?? null,
        result_duration_ms: row.latestResult?.durationMs ?? null,
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
