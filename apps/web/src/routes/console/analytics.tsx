import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleAnalytics() {
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Analytics</h1>
          <p>Sessions, tools, errors, models, and projects reports.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState title="Analytics placeholder" description="Lane 07 exposes the five existing report semantics." />
      </div>
    </>
  )
}
