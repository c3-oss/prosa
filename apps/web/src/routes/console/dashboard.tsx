import { useQuery } from '@tanstack/react-query'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { DashboardGrid } from '~/components/console/dashboard/dashboard-grid.js'
import { MetricCardGrid } from '~/components/console/metric-card-grid.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { queryKeys } from '~/lib/query-keys.js'

type AnalyticsSummary = {
  counts: { sessions: number; objects: number; docs: number; sources: number }
  sources: Array<{ sourceKind: string; count: number }>
}

export function ConsoleDashboard() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null

  const summary = useQuery({
    enabled: Boolean(tenantId),
    queryKey: tenantId ? queryKeys.analyticsSummary(tenantId) : ['analytics', 'summary', 'no-tenant'],
    queryFn: async (): Promise<AnalyticsSummary> => api.analytics.summary.query(),
  })

  const empty = summary.data && summary.data.counts.sessions === 0

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Tenant-scoped overview of promoted prosa history.</p>
        </div>
      </header>
      <div className="console-content">
        {!tenantId ? (
          <EmptyState
            title="Pick a tenant to continue"
            description="Use the tenant switcher to choose an active tenant. Console reads are tenant-scoped."
          />
        ) : summary.error ? (
          <EmptyState
            title="Could not load analytics"
            description={summary.error instanceof Error ? summary.error.message : 'Unknown error'}
          />
        ) : (
          <>
            <MetricCardGrid summary={summary.data ?? null} isLoading={summary.isLoading} />
            {empty ? (
              <EmptyState
                title="No promoted sessions yet"
                description="Run the CLI on each device that owns agent history, then push to this tenant to populate the console."
                code="prosa auth login && prosa sync push"
              />
            ) : (
              <DashboardGrid tenantId={tenantId} />
            )}
          </>
        )}
      </div>
    </>
  )
}
