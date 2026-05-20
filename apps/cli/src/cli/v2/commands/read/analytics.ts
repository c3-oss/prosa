// Lane 7 — `prosa read analytics <report>`.
//
// Consumes `/v2/reads/analytics/report`. The server schema is
// strict: it accepts `report`, `sourceTools`, `since`, `until`,
// `limit`. No cursor (the report set is bounded) and no project
// filter (server-side aggregations don't pivot on project today).
// Each row is a `Record<string, string | number | null>`; the
// column rendering layer falls back to the row's natural keys.

import { Command } from 'commander'
import { CliUserError } from '../../../errors.js'
import { printRows } from '../../../output.js'
import type { AnalyticsReportKind } from '../../client/index.js'
import {
  type CommonReadOptions,
  addCommonReadOptions,
  parseOutputFormat,
  prepareV2Read,
  with412RefreshAndRetry,
} from './common.js'

const REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const

function parseReport(value: string): AnalyticsReportKind {
  if ((REPORTS as readonly string[]).includes(value)) return value as AnalyticsReportKind
  throw new CliUserError(`invalid report: ${value} (expected one of ${REPORTS.join(', ')})`)
}

type AnalyticsOptions = CommonReadOptions & {
  source?: string[]
  since?: string
  until?: string
  limit: string
  outputFormat: string
  columns?: string
}

function collectArrayFlag(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value]
}

export function readAnalyticsCommand(): Command {
  const cmd = new Command('analytics')
    .description('Fixed analytics reports via the receipt-pinned v2 read API.')
    .argument('<report>', `report name: ${REPORTS.join('|')}`)
  addCommonReadOptions(cmd)
  cmd
    .option('--source <tool>', 'filter by source tool (repeatable)', collectArrayFlag)
    .option('--since <iso>', 'start window (ISO timestamp)')
    .option('--until <iso>', 'end window (ISO timestamp)')
    .option('--limit <n>', 'maximum rows', '500')
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

      const response = await with412RefreshAndRetry(ctx, (cur) => {
        if (cur.kind !== 'remote') throw new Error('expected remote context')
        return cur.client.analyticsReport({
          report: kind,
          limit,
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
          ...(options.source?.length ? { sourceTools: options.source } : {}),
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
          generatedAt: response.generatedAt,
          storeId: ctx.storeId,
          receiptId: ctx.authority.receiptId,
          auditStatus: ctx.authority.auditStatus,
        },
      })
    })
  return cmd
}
