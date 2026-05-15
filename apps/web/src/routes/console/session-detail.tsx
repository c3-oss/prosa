import { useParams } from '@tanstack/react-router'

import { EmptyState } from '~/components/primitives/empty-state.js'

export function ConsoleSessionDetail() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Session {sessionId ?? ''}</h1>
          <p>Timeline of messages, content blocks, tool calls, tool results, and artifacts.</p>
        </div>
      </header>
      <div className="console-content">
        <EmptyState
          title="Timeline placeholder"
          description="Lane 06 renders sessions.detail as structured timeline events."
        />
      </div>
    </>
  )
}
