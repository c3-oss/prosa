import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { useAppContext } from '~/app/providers.js'
import { queryKeys } from '~/lib/query-keys.js'

type ActivityRow = { date: string; count: number }
type ActivityResponse = { rows: ActivityRow[]; windowDays: number; generatedAt: string }

const WINDOW_OPTIONS: Array<{ label: string; days: number }> = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
]

export function DailyThreadsWidget({ tenantId }: { tenantId: string }) {
  const { api } = useAppContext()
  const [days, setDays] = useState(90)
  const threads = useQuery({
    queryKey: queryKeys.analyticsActivity(tenantId, days),
    queryFn: async (): Promise<ActivityResponse> => api.analytics.activity.query({ days }),
  })

  const rows = threads.data?.rows ?? []

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-2)' }}>
        <div className="dashboard-window-toggle" role="tablist" aria-label="Time window">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              role="tab"
              data-active={opt.days === days}
              onClick={() => setDays(opt.days)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dashboard-chart-wrapper">
        {threads.isLoading ? (
          <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>
            No sessions in the last {days} days.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minHeight={180}>
            <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'var(--color-text-faint)' }}
                stroke="var(--color-border)"
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-text-faint)' }}
                stroke="var(--color-border)"
                allowDecimals={false}
                width={32}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text)',
                }}
                labelStyle={{ color: 'var(--color-text-muted)' }}
              />
              <Line
                type="monotone"
                dataKey="count"
                name="threads"
                stroke="var(--color-accent-strong)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  )
}
