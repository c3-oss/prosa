import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { formatAbsoluteTime, truncate } from '~/lib/format.js'
import { queryKeys } from '~/lib/query-keys.js'

type ToolCallRow = {
  id: string
  sessionId: string
  sessionTitle: string | null
  sourceKind: string
  name: string
  status: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  resultStatus: string | null
}

type ToolCallPage = { rows: ToolCallRow[]; nextCursor: string | null }

export function ConsoleToolCalls() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)

  const input = {
    limit: 50,
    ...(errorsOnly ? { errorsOnly: true as const } : {}),
    ...(cursor ? { cursor } : {}),
  }

  const calls = useQuery({
    enabled: Boolean(tenantId),
    queryKey: tenantId ? queryKeys.toolCallsList(tenantId, input) : ['toolCalls', 'list', 'no-tenant'],
    queryFn: async (): Promise<ToolCallPage> => api.toolCalls.list.query(input),
    placeholderData: keepPreviousData,
  })

  const rows = calls.data?.rows ?? []

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Tool calls</h1>
          <p>Audit view across promoted tool calls for this tenant.</p>
        </div>
      </header>
      <div className="console-content" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              color: 'var(--color-text-muted)',
            }}
          >
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => {
                setErrorsOnly(e.target.checked)
                setCursor(null)
              }}
            />
            <span style={{ fontSize: 'var(--font-size-sm)' }}>Errors only</span>
          </label>
        </div>
        {!tenantId ? (
          <EmptyState title="Pick a tenant to continue" description="Tool calls are tenant-scoped." />
        ) : calls.error ? (
          <EmptyState
            title="Could not load tool calls"
            description={calls.error instanceof Error ? calls.error.message : 'Unknown error'}
          />
        ) : rows.length === 0 && !calls.isFetching ? (
          <EmptyState title="No tool calls" description="No promoted tool calls match the current filters." />
        ) : (
          <table className="console-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Tool</th>
                <th>Source</th>
                <th>Status</th>
                <th>Result</th>
                <th>Session</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{formatAbsoluteTime(row.startedAt)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{truncate(row.name, 40)}</td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {row.sourceKind}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{row.status ?? '—'}</td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      color:
                        row.resultStatus && !['ok', 'success', 'completed'].includes(row.resultStatus)
                          ? 'var(--color-warning)'
                          : 'var(--color-text-muted)',
                    }}
                  >
                    {row.resultStatus ?? '—'}
                  </td>
                  <td>
                    <Link to="/console/sessions/$sessionId" params={{ sessionId: row.sessionId }}>
                      {row.sessionTitle ? truncate(row.sessionTitle, 36) : row.sessionId}
                    </Link>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>
                    {row.durationMs == null ? '—' : `${row.durationMs} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {calls.data?.nextCursor ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setCursor(calls.data?.nextCursor ?? null)}
            disabled={calls.isFetching}
          >
            {calls.isFetching ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
    </>
  )
}
