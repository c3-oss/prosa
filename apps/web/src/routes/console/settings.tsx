import { useParams } from '@tanstack/react-router'

import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleSettings() {
  const { section } = useParams({ strict: false }) as { section?: string }
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Settings · {section ?? 'team'}</h1>
          <p>Tenant members, invites, roles, and account.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState title="Settings placeholder" description="Lane 03 wires team/account flows." />
      </div>
    </>
  )
}
