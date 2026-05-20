// Lane 7 — `prosa read analytics <report>`.
//
// Consumes `/v2/reads/analytics/report`. The report set mirrors
// the existing `prosa analytics` command: sessions|tools|errors|
// models|projects. Each row is shaped as a record<string, unknown>;
// the column rendering layer falls back to the row's natural keys.

import { Command } from 'commander'
import { CliUserError } from '../../../errors.js'
import { printRows } from '../../../output.js'
import {
  type CommonReadOptions,
  addCommonReadOptions,
  parseOutputFormat,
  prepareV2Read,
  with412Retry,
} from './common.js'

const REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const
type AnalyticsReport = (typeof REPORTS)[number]

function parseReport(value: string): AnalyticsReport {
  if ((REPORTS as readonly string[]).includes(value)) return value as AnalyticsReport
  throw new CliUserError(`invalid report: ${value} (expected one of ${REPORTS.join(', ')})`)
}

type AnalyticsOptions = CommonReadOptions & {
  source?: string
  project?: string
  since?: string
  until?: string
  limit: string
  cursor?: string
  outputFormat: string
  columns?: string
}

export function readAnalyticsCommand(): Command {
  const cmd = new Command('analytics')
    .description('Fixed analytics reports via the receipt-pinned v2 read API.')
    .argument('<report>', `report name: ${REPORTS.join('|')}`)
  addCommonReadOptions(cmd)
  cmd
    .option('--source <tool>', 'filter by source tool')
    .option('--project <id>', 'filter by project id')
    .option('--since <iso>', 'start window (ISO timestamp)')
    .option('--until <iso>', 'end window (ISO timestamp)')
    .option('--limit <n>', 'maximum rows per page', '100')
    .option('--cursor <token>', 'opaque page cursor from a prior response')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .option('--columns <list>', 'comma-separated columns to render (defaults to all keys present)')
    .action(async (report: string, options: AnalyticsOptions) => {
      const kind = parseReport(report)
      const format = parseOutputFormat(options.outputFormat, 'table')
      const limit = Number.parseInt(options.limit, 10)
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new CliUserError(`invalid --limit: ${options.limit}`)
      }

      const ctx = await prepareV2Read({ commandName: 'prosa read analytics', options })
      if (ctx.kind === 'local') {
        throw new CliUserError(
          'prosa read analytics requires a remote-promoted store; for local analytics use `prosa analytics`.',
        )
      }

      const response = await with412Retry(ctx, (cur) => {
        if (cur.kind !== 'remote') throw new Error('expected remote context')
        return cur.client.analyticsReport({
          report: kind,
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
          ...(options.source ? { sourceTools: [options.source] } : {}),
          ...(options.project ? { projectIds: [options.project] } : {}),
        })
      })

      const naturalKeys = Array.from(new Set(response.rows.flatMap((row) => Object.keys(row))))
      const columns = options.columns
        ? options.columns
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
        : naturalKeys

      printRows(response.rows, {
        format,
        columns,
        meta: {
          source: 'remote',
          server: ctx.entry.url,
          report: kind,
          storeId: ctx.storeId,
          receiptId: ctx.authority.receiptId,
          auditStatus: ctx.authority.auditStatus,
          nextCursor: response.nextCursor,
        },
      })
    })
  return cmd
}
