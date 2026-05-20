/**
 * CQ-153 — daily threads pulls from the same bespoke
 * `analytics.activity` tRPC procedure with no v2 counterpart.
 * Render an explicit unavailable state until
 * `/v2/reads/analytics/activity` lands.
 */
export function DailyThreadsWidget(_: { tenantId: string }) {
  return (
    <div className="dashboard-line-chart" aria-label="Daily threads chart pending v2">
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
        Daily threads chart is pending a `/v2/reads/analytics/activity` endpoint (CQ-153 follow-up).
      </p>
    </div>
  )
}
