import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { useAppContext } from '~/app/providers.js'
import { queryKeys } from '~/lib/query-keys.js'

type TokensRow = { date: string; sourceKind: string; tokens: number }
type TokensResponse = { rows: TokensRow[]; windowDays: number; generatedAt: string }

const WINDOW_OPTIONS: Array<{ label: string; days: number }> = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
]

const SOURCE_COLORS: Record<string, string> = {
  claude: '#aa6518',
  codex: '#277b7b',
  gemini: '#4a6cf7',
  cursor: '#7a4fbf',
  hermes: '#b45f11',
}

function colorFor(source: string): string {
  return SOURCE_COLORS[source] ?? 'var(--color-text-muted)'
}

export function TokensByAgentWidget({ tenantId }: { tenantId: string }) {
  const { api } = useAppContext()
  const [days, setDays] = useState(90)
  const tokens = useQuery({
    queryKey: queryKeys.analyticsDailyTokensByAgent(tenantId, days),
    queryFn: async (): Promise<TokensResponse> => api.analytics.dailyTokensByAgent.query({ days }),
  })

  const { wide, sources } = useMemo(() => pivotRows(tokens.data?.rows ?? []), [tokens.data])

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
        {tokens.isLoading ? (
          <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>Loading…</p>
        ) : wide.length === 0 ? (
          <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>
            No token usage in the last {days} days. Token counts populate after the next `prosa sync push`.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minHeight={180}>
            <LineChart data={wide} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
                width={48}
                tickFormatter={formatTokenShort}
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
                formatter={(value: number, name: string) => [Number(value).toLocaleString(), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="line" />
              {sources.map((source) => (
                <Line
                  key={source}
                  type="monotone"
                  dataKey={source}
                  name={source}
                  stroke={colorFor(source)}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  )
}

function pivotRows(rows: TokensRow[]): { wide: Array<Record<string, number | string>>; sources: string[] } {
  const byDate = new Map<string, Record<string, number | string>>()
  const sources = new Set<string>()
  for (const row of rows) {
    sources.add(row.sourceKind)
    const entry = byDate.get(row.date) ?? { date: row.date }
    entry[row.sourceKind] = row.tokens
    byDate.set(row.date, entry)
  }
  const dates = Array.from(byDate.keys()).sort()
  const wide = dates.map((date) => byDate.get(date) ?? { date })
  return { wide, sources: Array.from(sources).sort() }
}

function formatTokenShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
