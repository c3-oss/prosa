/**
 * CQ-153 — `dailyTokensByAgent` is a bespoke tRPC procedure with
 * no v2 counterpart. Render an explicit unavailable state until a
 * `/v2/reads/analytics/tokens-by-agent` endpoint lands.
 */
export function TokensByAgentWidget(_: { tenantId: string }) {
  return (
    <div className="dashboard-tokens-by-agent" aria-label="Tokens-by-agent chart pending v2">
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
        Tokens-by-agent chart is pending a `/v2/reads/analytics/tokens-by-agent` endpoint (CQ-153 follow-up).
      </p>
    </div>
  )
}
