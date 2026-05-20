/**
 * CQ-153 — `activity` is a bespoke tRPC procedure with no v2 read
 * counterpart yet. Per the acceptance criteria we render an
 * explicit unavailable state instead of falling back to the legacy
 * tRPC `analytics.activity.query`. Tracked as a CQ-153 follow-up
 * for a future `/v2/reads/analytics/activity` endpoint.
 */
export function ActivityWidget(_: { tenantId: string }) {
  return (
    <div className="dashboard-heatmap" aria-label="Activity heatmap pending v2">
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
        Activity heatmap is pending a `/v2/reads/analytics/activity` endpoint (CQ-153 follow-up).
      </p>
    </div>
  )
}
