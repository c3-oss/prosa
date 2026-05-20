// Lane 7 — `prosa read search <query>`.
//
// Consumes `/v2/reads/search/query`. When `--authority local` is in
// effect (or no v2 promotion is recorded), falls back to the local
// search service exposed by prosa-core so the command stays usable
// off-line.

import { searchFullText } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { withBundle } from '../../../bundle.js'
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

type SearchCol =
  | 'timestamp'
  | 'source_tool'
  | 'session_id'
  | 'role'
  | 'tool_name'
  | 'snippet'
  | 'canonical_type'
  | 'store_id'
  | 'receipt_id'

const SEARCH_COLUMNS: ColumnSet<SearchCol> = {
  default: ['timestamp', 'source_tool', 'session_id', 'role', 'tool_name', 'snippet'],
  all: [
    'timestamp',
    'source_tool',
    'session_id',
    'role',
    'tool_name',
    'snippet',
    'canonical_type',
    'store_id',
    'receipt_id',
  ],
  maxWidths: {
    session_id: 14,
    snippet: 80,
    store_id: 14,
    receipt_id: 14,
  },
  tail: new Set(),
}

type SearchOptions = CommonReadOptions & {
  role?: string
  toolName?: string
  canonicalType?: string
  errorsOnly: boolean
  source?: string
  project?: string
  limit: string
  cursor?: string
  outputFormat: string
  columns?: string
}

export function readSearchCommand(): Command {
  const cmd = new Command('search')
    .description('Full-text search via the receipt-pinned v2 read API.')
    .argument('<query>', 'search query')
  addCommonReadOptions(cmd)
  cmd
    .option('--role <role>', 'filter by message role')
    .option('--tool-name <name>', 'filter by tool name')
    .option('--canonical-type <type>', 'filter by canonical entity type')
    .option('--errors-only', 'only return hits flagged as errors', false)
    .option('--source <tool>', 'filter by source tool')
    .option('--project <id>', 'filter by project id')
    .option('--limit <n>', 'maximum rows per page', '50')
    .option('--cursor <token>', 'opaque page cursor from a prior response')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .option(
      '--columns <list>',
      `comma-separated columns to show (or 'default'|'all'); available: ${SEARCH_COLUMNS.all.join(', ')}`,
    )
    .action(async (query: string, options: SearchOptions) => {
      const format = parseOutputFormat(options.outputFormat, 'table')
      const columns = resolveColumns(SEARCH_COLUMNS, options.columns)
      const limit = Number.parseInt(options.limit, 10)
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new CliUserError(`invalid --limit: ${options.limit}`)
      }

      const ctx = await prepareV2Read({ commandName: 'prosa read search', options })

      if (ctx.kind === 'local') {
        await withBundle(ctx.storePath, (bundle) => {
          const rows = searchFullText(bundle, { query, limit })
          printRows(rows, {
            format,
            columns,
            maxColumnWidths: maxWidthsForColumns(SEARCH_COLUMNS, columns),
            tailColumns: tailColumnsFor(SEARCH_COLUMNS, columns),
            meta: { source: 'local', query },
          })
        })
        return
      }

      const response = await with412Retry(ctx, (cur) => {
        if (cur.kind !== 'remote') throw new Error('expected remote context')
        return cur.client.searchQuery({
          q: query,
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.role ? { role: options.role } : {}),
          ...(options.toolName ? { toolName: options.toolName } : {}),
          ...(options.canonicalType ? { canonicalType: options.canonicalType } : {}),
          ...(options.errorsOnly ? { errorsOnly: true } : {}),
          ...(options.source ? { sourceTools: [options.source] } : {}),
          ...(options.project ? { projectIds: [options.project] } : {}),
        })
      })

      const shaped = response.rows.map((row) => ({
        timestamp: row.timestamp,
        source_tool: row.sourceTool,
        session_id: row.sessionId,
        role: row.role,
        tool_name: row.toolName,
        snippet: row.snippet,
        canonical_type: row.canonicalType,
        store_id: row.storeId,
        receipt_id: row.receiptId,
      }))

      printRows(shaped, {
        format,
        columns,
        maxColumnWidths: maxWidthsForColumns(SEARCH_COLUMNS, columns),
        tailColumns: tailColumnsFor(SEARCH_COLUMNS, columns),
        meta: {
          source: 'remote',
          server: ctx.entry.url,
          storeId: ctx.storeId,
          receiptId: ctx.authority.receiptId,
          auditStatus: ctx.authority.auditStatus,
          nextCursor: response.nextCursor,
          query,
        },
      })
    })
  return cmd
}
