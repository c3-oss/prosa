import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleDashboard() {
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Tenant-scoped overview of promoted prosa history.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState
          title="Sign in to load tenant data"
          description="The dashboard renders verified, promoted sessions, search docs, and source breakdowns once you authenticate."
          code="prosa auth login && prosa sync push"
        />
      </div>
    </>
  )
}
