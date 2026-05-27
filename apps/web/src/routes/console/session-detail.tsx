import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { type TranscriptToolCall, type TranscriptTurn, TranscriptView } from '~/components/console/transcript/index.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { formatAbsoluteTime, formatCount } from '~/lib/format.js'
import { queryKeys } from '~/lib/query-keys.js'

type TranscriptPage = {
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
  turns: TranscriptTurn[]
  nextCursor: string | null
  unattachedToolCalls: TranscriptToolCall[]
} | null

const TRANSCRIPT_PAGE_SIZE = 50

export function ConsoleSessionDetail() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  const { apiV2 } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null

  const [pageCursor, setPageCursor] = useState<string | null>(null)
  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  const [unattached, setUnattached] = useState<TranscriptToolCall[]>([])

  // Reset accumulators on session change. The query key includes the cursor
  // so a fresh first page kicks in automatically.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger.
  useEffect(() => {
    setPageCursor(null)
    setTurns([])
    setUnattached([])
  }, [sessionId])

  const transcript = useQuery<TranscriptPage>({
    enabled: Boolean(tenantId && sessionId),
    queryKey:
      tenantId && sessionId
        ? queryKeys.sessionTranscript(tenantId, sessionId, pageCursor)
        : ['sessions', 'transcript', 'no-tenant'],
    queryFn: async (): Promise<TranscriptPage> => {
      if (!sessionId) return null
      const response = await apiV2.v2.sessions.transcript({
        sessionId,
        limit: TRANSCRIPT_PAGE_SIZE,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      })
      if (!response) return null
      // CQ-153: shim v2 transcript payload into the existing
      // component shape. The v2 schema does not surface
      // messageCount/toolCallCount/errorCount on the session
      // payload — they're derived from projection rows the
      // dedicated endpoints (CQ-153 follow-up) will eventually
      // own. Default to 0 to keep the existing summary row stable.
      return {
        session: {
          id: response.session.id,
          sourceKind: response.session.sourceTool,
          title: response.session.title,
          startedAt: response.session.startedAt,
          endedAt: response.session.endedAt,
          durationMs: response.session.durationMs,
          messageCount: 0,
          toolCallCount: 0,
          errorCount: 0,
        },
        turns: response.turns.map((t) => ({
          messageId: t.messageId,
          ordinal: t.ordinal,
          role: t.role,
          model: t.model,
          timestamp: t.timestamp,
          blocks: t.blocks.map((b) => ({
            blockId: b.blockId,
            blockType: b.blockType,
            textInline: b.textInline,
            textObjectId: b.textObjectId,
            hidden: b.hidden,
            isError: b.isError,
            mimeType: b.mimeType,
          })),
          toolCalls: t.toolCalls.map((c) => ({
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            canonicalToolType: c.canonicalToolType,
            argsInline: null,
            argsObjectId: null,
            command: null,
            path: null,
            status: c.status,
            timestampStart: c.timestampStart,
            result: c.result
              ? {
                  toolResultId: c.result.toolResultId,
                  status: c.result.status,
                  isError: c.result.isError,
                  exitCode: c.result.exitCode,
                  durationMs: c.result.durationMs,
                  preview: null,
                  stdoutObjectId: null,
                  stderrObjectId: null,
                  outputObjectId: null,
                }
              : null,
          })),
        })),
        nextCursor: response.nextCursor,
        unattachedToolCalls: response.unattachedToolCalls.map((c) => ({
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          canonicalToolType: c.canonicalToolType,
          argsInline: null,
          argsObjectId: null,
          command: null,
          path: null,
          status: c.status,
          timestampStart: c.timestampStart,
          result: c.result
            ? {
                toolResultId: c.result.toolResultId,
                status: c.result.status,
                isError: c.result.isError,
                exitCode: c.result.exitCode,
                durationMs: c.result.durationMs,
                preview: null,
                stdoutObjectId: null,
                stderrObjectId: null,
                outputObjectId: null,
              }
            : null,
        })),
      }
    },
    placeholderData: keepPreviousData,
  })

  // Append new pages so "Load more" extends instead of replaces.
  useEffect(() => {
    const data = transcript.data
    if (!data) return
    setTurns((prev) => {
      const seen = new Set(prev.map((turn) => turn.messageId))
      const additions = data.turns.filter((turn) => !seen.has(turn.messageId))
      if (additions.length === 0) return prev
      return [...prev, ...additions]
    })
    // Unattached tool calls only come back on the first page.
    if (pageCursor == null && data.unattachedToolCalls.length > 0) {
      setUnattached(data.unattachedToolCalls)
    }
  }, [transcript.data, pageCursor])

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

  const session = transcript.data?.session ?? null
  const nextCursor = transcript.data?.nextCursor ?? null

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
        ) : transcript.error ? (
          <EmptyState
            title="Could not load session"
            description={transcript.error instanceof Error ? transcript.error.message : 'Unknown error'}
          />
        ) : transcript.isLoading && !session ? (
          <p style={{ color: 'var(--color-text-muted)' }}>Loading session…</p>
        ) : !session ? (
          <EmptyState
            title="Session not found"
            description="The session may not be promoted or you may not have access."
          />
        ) : (
          <>
            <section aria-label="Session summary" className="console-summary-grid">
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
            {turns.length === 0 ? (
              <EmptyState
                title="No transcript yet"
                description="This session has no promoted messages yet. Re-sync to populate the transcript."
              />
            ) : (
              <TranscriptView turns={turns} unattachedToolCalls={unattached} />
            )}
            {nextCursor ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPageCursor(nextCursor)}
                disabled={transcript.isFetching}
              >
                {transcript.isFetching ? 'Loading…' : 'Load more turns'}
              </Button>
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
    <div className="console-summary-cell">
      <span className="console-summary-label">{label}</span>
      <span className={mono ? 'console-summary-value console-mono' : 'console-summary-value'} style={{ color }}>
        {value}
      </span>
    </div>
  )
}
