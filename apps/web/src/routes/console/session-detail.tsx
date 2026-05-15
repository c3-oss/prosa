import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { EventInspector } from '~/components/console/event-inspector.js'
import { type TimelineEvent, TimelineEventCard } from '~/components/console/timeline-event.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { formatAbsoluteTime, formatCount } from '~/lib/format.js'
import { queryKeys } from '~/lib/query-keys.js'

type DetailPayload = {
  session: {
    id: string
    sourceKind: string
    title: string | null
    startedAt: string | null
    endedAt: string | null
    durationMs: number | null
    messageCount: number
    toolCallCount: number
    errorCount: number
    metadata?: unknown
  }
  events: { rows: TimelineEvent[]; nextCursor: string | null }
  relatedArtifacts: Array<{ id: string; kind: string; objectId: string | null; sizeBytes: number | null }>
}

export function ConsoleSessionDetail() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null

  const [eventCursor, setEventCursor] = useState<string | null>(null)
  const [accumulatedEvents, setAccumulatedEvents] = useState<TimelineEvent[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Reset accumulated state when the session id changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; the other setters are stable.
  useEffect(() => {
    setEventCursor(null)
    setAccumulatedEvents([])
    setSelectedId(null)
  }, [sessionId])

  const detail = useQuery({
    enabled: Boolean(tenantId && sessionId),
    queryKey:
      tenantId && sessionId
        ? [...queryKeys.sessionDetail(tenantId, sessionId), eventCursor ?? 'first']
        : ['sessions', 'detail', 'no-tenant'],
    queryFn: async (): Promise<DetailPayload | null> => {
      if (!sessionId) return null
      return api.sessions.detail.query({
        sessionId,
        ...(eventCursor ? { cursor: eventCursor } : {}),
      })
    },
    placeholderData: keepPreviousData,
  })

  // Append new event pages to the local accumulator so "load more" extends
  // the timeline instead of replacing it.
  useEffect(() => {
    const incoming = detail.data?.events.rows ?? []
    if (incoming.length === 0) return
    setAccumulatedEvents((prev) => {
      const seen = new Set(prev.map((event) => event.id))
      const additions = incoming.filter((event) => !seen.has(event.id))
      if (additions.length === 0) return prev
      return [...prev, ...additions]
    })
  }, [detail.data])

  if (!sessionId) {
    return (
      <>
        <header className="console-page-header">
          <div>
            <h1>Session</h1>
            <p>Missing session id.</p>
          </div>
        </header>
        <div className="console-content">
          <EmptyState title="Session not specified" description="Use the sessions list to open a session." />
        </div>
      </>
    )
  }

  const session = detail.data?.session ?? null
  const nextCursor = detail.data?.events.nextCursor ?? null
  const selectedEvent = accumulatedEvents.find((event) => event.id === selectedId) ?? null

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>{session?.title ?? 'Session'}</h1>
          <p>
            <Link to="/console/sessions" style={{ color: 'var(--color-text-muted)' }}>
              ← Back to sessions
            </Link>
          </p>
        </div>
      </header>
      <div className="console-content" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {!tenantId ? (
          <EmptyState title="Pick a tenant to continue" description="Session details are tenant-scoped." />
        ) : detail.error ? (
          <EmptyState
            title="Could not load session"
            description={detail.error instanceof Error ? detail.error.message : 'Unknown error'}
          />
        ) : detail.isLoading && !session ? (
          <p style={{ color: 'var(--color-text-muted)' }}>Loading session…</p>
        ) : !session ? (
          <EmptyState
            title="Session not found"
            description="The session may not be promoted or you may not have access."
          />
        ) : (
          <>
            <section
              aria-label="Session summary"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              <SummaryCell label="Source" value={session.sourceKind} mono />
              <SummaryCell label="Started" value={formatAbsoluteTime(session.startedAt)} mono />
              <SummaryCell label="Ended" value={formatAbsoluteTime(session.endedAt)} mono />
              <SummaryCell label="Messages" value={formatCount(session.messageCount)} mono />
              <SummaryCell label="Tool calls" value={formatCount(session.toolCallCount)} mono />
              <SummaryCell
                label="Errors"
                value={formatCount(session.errorCount)}
                mono
                tone={session.errorCount > 0 ? 'warning' : 'muted'}
              />
            </section>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: 'var(--space-4)',
              }}
            >
              <section
                aria-label="Timeline"
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}
              >
                {accumulatedEvents.length === 0 ? (
                  <EmptyState
                    title="No events yet"
                    description="This session does not have timeline events promoted yet. Re-sync to populate events."
                  />
                ) : (
                  accumulatedEvents.map((event) => (
                    <TimelineEventCard
                      key={event.id}
                      event={event}
                      selected={event.id === selectedId}
                      onSelect={() => setSelectedId(event.id)}
                    />
                  ))
                )}
                {nextCursor ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEventCursor(nextCursor)}
                    disabled={detail.isFetching}
                  >
                    {detail.isFetching ? 'Loading…' : 'Load more events'}
                  </Button>
                ) : null}
              </section>
              <EventInspector event={selectedEvent} />
            </div>
            {detail.data?.relatedArtifacts && detail.data.relatedArtifacts.length > 0 ? (
              <section aria-label="Related artifacts">
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'var(--font-size-md)',
                    color: 'var(--color-text-muted)',
                    marginBottom: 'var(--space-2)',
                  }}
                >
                  Related artifacts
                </h2>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}>
                  {detail.data.relatedArtifacts.map((artifact) => (
                    <li
                      key={artifact.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        background: 'var(--color-panel)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        padding: 'var(--space-3) var(--space-4)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--font-size-sm)',
                      }}
                    >
                      <span>{artifact.kind}</span>
                      <span style={{ color: 'var(--color-text-faint)' }}>
                        {artifact.sizeBytes == null ? '—' : `${artifact.sizeBytes.toLocaleString()} bytes`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

function SummaryCell({
  label,
  value,
  mono,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'default' | 'warning' | 'muted'
}) {
  const color = tone === 'warning' ? 'var(--color-warning)' : 'var(--color-text)'
  return (
    <div
      style={{
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-3) var(--space-4)',
      }}
    >
      <span
        style={{
          display: 'block',
          color: 'var(--color-text-faint)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-xs)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          color,
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
          fontSize: 'var(--font-size-md)',
        }}
      >
        {value}
      </span>
    </div>
  )
}
