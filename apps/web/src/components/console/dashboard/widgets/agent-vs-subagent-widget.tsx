import { useQuery } from '@tanstack/react-query'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import { useAppContext } from '~/app/providers.js'
import { queryKeys } from '~/lib/query-keys.js'

type RatioResponse = {
  sessions: { user: number; subagent: number }
  tokens: { user: number; subagent: number }
  windowDays: number
  generatedAt: string
}

const COLOR_USER = '#aa6518'
const COLOR_SUBAGENT = '#277b7b'
const WINDOW_DAYS = 365

export function AgentVsSubagentWidget({ tenantId }: { tenantId: string }) {
  const { api } = useAppContext()
  const ratio = useQuery({
    queryKey: queryKeys.analyticsAgentVsSubagent(tenantId, WINDOW_DAYS),
    queryFn: async (): Promise<RatioResponse> => api.analytics.agentVsSubagent.query({ days: WINDOW_DAYS }),
  })

  const data = ratio.data
  const totalSessions = (data?.sessions.user ?? 0) + (data?.sessions.subagent ?? 0)
  const totalTokens = (data?.tokens.user ?? 0) + (data?.tokens.subagent ?? 0)

  if (ratio.isLoading) {
    return <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>Loading…</p>
  }

  if (totalSessions === 0) {
    return (
      <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>
        No promoted sessions in the last {WINDOW_DAYS} days. Subagent classification populates after the next sync push.
      </p>
    )
  }

  return (
    <>
      <div className="dashboard-ratio-row">
        <RatioCell
          label="Sessions"
          user={data?.sessions.user ?? 0}
          subagent={data?.sessions.subagent ?? 0}
          formatValue={(n) => n.toLocaleString()}
        />
        <RatioCell
          label="Tokens"
          user={data?.tokens.user ?? 0}
          subagent={data?.tokens.subagent ?? 0}
          formatValue={(n) => (totalTokens > 0 ? n.toLocaleString() : '–')}
          empty={totalTokens === 0}
        />
      </div>
      <div className="dashboard-ratio-legend">
        <span>
          <span className="dashboard-ratio-legend-dot" style={{ background: COLOR_USER }} /> User-initiated
        </span>
        <span>
          <span className="dashboard-ratio-legend-dot" style={{ background: COLOR_SUBAGENT }} /> Subagent
        </span>
      </div>
    </>
  )
}

function RatioCell(props: {
  label: string
  user: number
  subagent: number
  formatValue: (n: number) => string
  empty?: boolean
}) {
  const { label, user, subagent, formatValue, empty } = props
  const total = user + subagent
  const pct = total > 0 ? Math.round((user / total) * 100) : 0
  const pieData = empty
    ? [{ name: 'empty', value: 1 }]
    : [
        { name: 'user', value: user },
        { name: 'subagent', value: subagent },
      ]
  return (
    <div className="dashboard-ratio-cell">
      <span className="dashboard-ratio-cell-label">{label}</span>
      <div style={{ width: '100%', height: 120, minHeight: 100 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              dataKey="value"
              innerRadius="60%"
              outerRadius="90%"
              stroke="none"
              isAnimationActive={false}
            >
              {empty ? (
                <Cell fill="var(--color-code-bg)" />
              ) : (
                <>
                  <Cell fill={COLOR_USER} />
                  <Cell fill={COLOR_SUBAGENT} />
                </>
              )}
            </Pie>
            {empty ? null : <Tooltip formatter={(value: number, name: string) => [formatValue(value), name]} />}
          </PieChart>
        </ResponsiveContainer>
      </div>
      <span className="dashboard-ratio-cell-value">{empty ? '—' : `${pct}%`}</span>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-faint)' }}>
        {formatValue(user)} / {formatValue(subagent)}
      </span>
    </div>
  )
}
