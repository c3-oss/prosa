import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleToolCalls() {
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Tool calls</h1>
          <p>Audit view across promoted tool calls — provider, status, errors, paths.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState title="Tool-call audit placeholder" description="Lane 07 wires toolCalls.list." />
      </div>
    </>
  )
}
