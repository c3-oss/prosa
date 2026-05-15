import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleSessions() {
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Sessions</h1>
          <p>Paginated session table with filters. Backed by sessions.list.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState
          title="Sessions table placeholder"
          description="Lane 05 populates this with cursor-paginated rows from sessions.list."
        />
      </div>
    </>
  )
}
