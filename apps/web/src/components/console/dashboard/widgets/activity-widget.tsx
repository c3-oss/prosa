import { useQuery } from '@tanstack/react-query'
import CalendarHeatmap from 'react-calendar-heatmap'

import { useAppContext } from '~/app/providers.js'
import { queryKeys } from '~/lib/query-keys.js'

const WINDOW_DAYS = 365

type ActivityRow = { date: string; count: number }
type ActivityResponse = { rows: ActivityRow[]; windowDays: number; generatedAt: string }

export function ActivityWidget({ tenantId }: { tenantId: string }) {
  const { api } = useAppContext()
  const activity = useQuery({
    queryKey: queryKeys.analyticsActivity(tenantId, WINDOW_DAYS),
    queryFn: async (): Promise<ActivityResponse> => api.analytics.activity.query({ days: WINDOW_DAYS }),
  })

  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(endDate.getDate() - WINDOW_DAYS)
  const values = activity.data?.rows ?? []
  const maxCount = values.reduce((acc, row) => (row.count > acc ? row.count : acc), 0)
  const total = values.reduce((acc, row) => acc + row.count, 0)

  return (
    <div className="dashboard-heatmap">
      {activity.isLoading ? (
        <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>Loading activity…</p>
      ) : values.length === 0 ? (
        <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>
          No promoted sessions in the last {WINDOW_DAYS} days.
        </p>
      ) : (
        <>
          <CalendarHeatmap
            startDate={startDate}
            endDate={endDate}
            values={values}
            classForValue={(value) => {
              if (!value || !('count' in value) || !value.count) return 'color-empty'
              const ratio = maxCount > 0 ? (value as ActivityRow).count / maxCount : 0
              if (ratio > 0.75) return 'color-scale-4'
              if (ratio > 0.5) return 'color-scale-3'
              if (ratio > 0.25) return 'color-scale-2'
              return 'color-scale-1'
            }}
            titleForValue={(value) => {
              if (!value || !('count' in value)) return ''
              return `${(value as ActivityRow).date}: ${(value as ActivityRow).count} session${
                (value as ActivityRow).count === 1 ? '' : 's'
              }`
            }}
            showWeekdayLabels
          />
          <div className="dashboard-heatmap-legend">
            <span>
              {total.toLocaleString()} sessions · last {WINDOW_DAYS} days
            </span>
            <span style={{ marginLeft: 'auto' }}>
              Less{' '}
              <span className="dashboard-heatmap-legend-cells">
                <span className="dashboard-heatmap-legend-cell" style={{ background: 'var(--color-code-bg)' }} />
                <span
                  className="dashboard-heatmap-legend-cell"
                  style={{ background: 'color-mix(in srgb, var(--color-accent) 25%, var(--color-code-bg))' }}
                />
                <span
                  className="dashboard-heatmap-legend-cell"
                  style={{ background: 'color-mix(in srgb, var(--color-accent) 50%, var(--color-code-bg))' }}
                />
                <span
                  className="dashboard-heatmap-legend-cell"
                  style={{ background: 'color-mix(in srgb, var(--color-accent) 75%, var(--color-code-bg))' }}
                />
                <span className="dashboard-heatmap-legend-cell" style={{ background: 'var(--color-accent-strong)' }} />
              </span>{' '}
              More
            </span>
          </div>
        </>
      )}
    </div>
  )
}
