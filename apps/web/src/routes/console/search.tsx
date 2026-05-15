import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleSearch() {
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Search</h1>
          <p>Postgres FTS over verified search_doc metadata.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState title="Search placeholder" description="Lane 07 wires query + filters + cursor pagination." />
      </div>
    </>
  )
}
