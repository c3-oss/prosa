import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { formatAbsoluteTime } from '~/lib/format.js'
import { queryKeys } from '~/lib/query-keys.js'

const REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const
type Report = (typeof REPORTS)[number]

type AnalyticsReport = { report: string; rows: Array<Record<string, unknown>>; generatedAt: string }

function renderCell(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function ConsoleAnalytics() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null
  const [report, setReport] = useState<Report>('sessions')

  const data = useQuery({
    enabled: Boolean(tenantId),
    queryKey: tenantId ? queryKeys.analyticsReport(tenantId, { report }) : ['analytics', 'report', 'no-tenant'],
    queryFn: async (): Promise<AnalyticsReport> => api.analytics.report.query({ report }),
  })

  const rows = data.data?.rows ?? []
  const columns = rows[0] ? Object.keys(rows[0]) : []

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Analytics</h1>
          <p>Five report semantics backed by analytics.report — same as the CLI analytics surface.</p>
        </div>
      </header>
      <div className="console-content">
        <nav aria-label="Report selector" className="console-segmented">
          {REPORTS.map((kind) => {
            const active = report === kind
            return (
              <button key={kind} type="button" onClick={() => setReport(kind)} aria-pressed={active}>
                {kind}
              </button>
            )
          })}
        </nav>
        {!tenantId ? (
          <EmptyState title="Pick a tenant to continue" description="Analytics is tenant-scoped." />
        ) : data.error ? (
          <EmptyState
            title="Could not load analytics"
            description={data.error instanceof Error ? data.error.message : 'Unknown error'}
          />
        ) : rows.length === 0 && !data.isLoading ? (
          <EmptyState title={`No data for ${report}`} description="Promote tenant data first via prosa sync push." />
        ) : (
          <section className="console-section" aria-label={`${report} report`}>
            <div className="console-section-header">
              <h2 className="console-section-title">{report} report</h2>
              {data.data?.generatedAt ? (
                <span className="console-faint console-mono">{formatAbsoluteTime(data.data.generatedAt)}</span>
              ) : null}
            </div>
            <div className="console-table-wrap">
              <table className="console-table">
                <thead>
                  <tr>
                    {columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: report rows have no stable composite key; ordinal is the stable position.
                    <tr key={`${report}-${idx}`}>
                      {columns.map((col) => (
                        <td key={col} className="console-mono">
                          {renderCell(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  )
}
