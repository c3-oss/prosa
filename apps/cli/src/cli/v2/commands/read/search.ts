// Lane 7 — `prosa v2 read search <query>`.
//
// Consumes `/v2/reads/search/query`. Filter flags map directly to
// the server schema (`roles`, `toolNames`, `canonicalToolTypes`,
// `entityTypes`, `sessionId`, `errorsOnly`, `since`, `until`).
// Flags absent from the server schema (e.g. `--source`, `--project`)
// are intentionally not exposed here so the CLI does not silently
// drop a filter the user asked for.
//
// Local-mode fallback: when no v2 promotion is recorded the CLI
// reads the local bundle via `searchFullText`. Local mode currently
// does not support `--errors-only`, `--session`, `--since`,
// `--until`, `--canonical-tool-type`, `--entity-type`, or
// `--tool-name` — passing those flags in local mode fails closed.

import { searchLocal } from '@c3-oss/prosa-derived-v2'
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

type SearchCol =
  | 'timestamp'
  | 'session_id'
  | 'role'
  | 'tool_name'
  | 'canonical_tool_type'
  | 'snippet'
  | 'entity_type'
  | 'rank'
  | 'errors_only'
  | 'store_id'
  | 'receipt_id'

const SEARCH_COLUMNS: ColumnSet<SearchCol> = {
  default: ['timestamp', 'session_id', 'role', 'tool_name', 'snippet'],
  all: [
    'timestamp',
    'session_id',
    'role',
    'tool_name',
    'canonical_tool_type',
    'entity_type',
    'snippet',
    'rank',
    'errors_only',
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
  role?: string[]
  toolName?: string[]
  canonicalToolType?: string[]
  entityType?: string[]
  errorsOnly: boolean
  session?: string
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

export function readSearchCommand(): Command {
  const cmd = new Command('search')
    .description('Full-text search via the receipt-pinned v2 read API.')
    .argument('<query>', 'search query')
  addCommonReadOptions(cmd)
  cmd
    .option('--role <role>', 'filter by message role (repeatable)', collectArrayFlag)
    .option('--tool-name <name>', 'filter by tool name (repeatable)', collectArrayFlag)
    .option('--canonical-tool-type <type>', 'filter by canonical tool type (repeatable)', collectArrayFlag)
    .option('--entity-type <type>', 'filter by entity type (repeatable)', collectArrayFlag)
    .option('--errors-only', 'only return hits flagged as errors', false)
    .option('--session <id>', 'filter by session id')
    .option('--since <iso>', 'lower bound on timestamp (inclusive)')
    .option('--until <iso>', 'upper bound on timestamp (exclusive)')
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

      const ctx = await prepareV2Read({ commandName: 'prosa v2 read search', options })

      if (ctx.kind === 'local') {
        rejectUnsupportedLocalFilters(options)
        const result = await searchLocal({ bundleRoot: ctx.storePath, query, limit })
        printRows(result.rows, {
          format,
          columns,
          maxColumnWidths: maxWidthsForColumns(SEARCH_COLUMNS, columns),
          tailColumns: tailColumnsFor(SEARCH_COLUMNS, columns),
          meta: { source: 'local', query, epoch: result.epoch },
        })
        return
      }

      const response = await with412RefreshAndRetry(ctx, (cur) => {
        if (cur.kind !== 'remote') throw new Error('expected remote context')
        return cur.client.searchQuery({
          q: query,
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.role?.length ? { roles: options.role } : {}),
          ...(options.toolName?.length ? { toolNames: options.toolName } : {}),
          ...(options.canonicalToolType?.length ? { canonicalToolTypes: options.canonicalToolType } : {}),
          ...(options.entityType?.length ? { entityTypes: options.entityType } : {}),
          ...(options.errorsOnly ? { errorsOnly: true } : {}),
          ...(options.session ? { sessionId: options.session } : {}),
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
        })
      })

      const shaped = response.rows.map((row) => ({
        timestamp: row.timestamp,
        session_id: row.sessionId,
        role: row.role,
        tool_name: row.toolName,
        canonical_tool_type: row.canonicalToolType,
        entity_type: row.entityType,
        snippet: row.snippet,
        rank: row.rank,
        errors_only: row.errorsOnly,
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

function rejectUnsupportedLocalFilters(options: SearchOptions): void {
  const unsupported: string[] = []
  if (options.role && options.role.length > 0) unsupported.push('--role')
  if (options.toolName && options.toolName.length > 0) unsupported.push('--tool-name')
  if (options.canonicalToolType && options.canonicalToolType.length > 0) unsupported.push('--canonical-tool-type')
  if (options.entityType && options.entityType.length > 0) unsupported.push('--entity-type')
  if (options.errorsOnly) unsupported.push('--errors-only')
  if (options.session) unsupported.push('--session')
  if (options.since) unsupported.push('--since')
  if (options.until) unsupported.push('--until')
  if (options.cursor) unsupported.push('--cursor')
  if (unsupported.length > 0) {
    throw new CliUserError(
      `prosa v2 read search local mode does not support ${unsupported.join(', ')}; rerun against a promoted store with --authority remote, or drop the unsupported filter.`,
    )
  }
}
