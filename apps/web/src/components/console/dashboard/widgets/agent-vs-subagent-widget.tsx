/**
 * CQ-153 — `agentVsSubagent` is a bespoke tRPC procedure with no
 * v2 counterpart. Render an explicit unavailable state until a
 * `/v2/reads/analytics/agent-vs-subagent` endpoint lands.
 */
export function AgentVsSubagentWidget(_: { tenantId: string }) {
  return (
    <div className="dashboard-ratio" aria-label="Agent vs subagent chart pending v2">
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
        Agent vs subagent ratio is pending a `/v2/reads/analytics/agent-vs-subagent` endpoint (CQ-153 follow-up).
      </p>
    </div>
  )
}
