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

function statusTone(status: string | null): 'success' | 'warning' | undefined {
  if (!status) return undefined
  return ['ok', 'success', 'completed'].includes(status) ? 'success' : 'warning'
}

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
      <div className="console-content">
        <div className="console-filters-toolbar">
          <label className="console-checkbox-pill">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => {
                setErrorsOnly(e.target.checked)
                setCursor(null)
              }}
            />
            <span>Errors only</span>
          </label>
          <div className="console-filters-right">
            <span>
              {rows.length}
              {calls.data?.nextCursor ? '+' : ''} tool call{rows.length === 1 ? '' : 's'}
            </span>
          </div>
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
          <div className="console-table-wrap">
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
                    <td className="console-mono">{formatAbsoluteTime(row.startedAt)}</td>
                    <td className="console-mono">{truncate(row.name, 40)}</td>
                    <td>
                      <span className="console-badge" data-tone="accent">
                        {row.sourceKind}
                      </span>
                    </td>
                    <td>
                      <span className="console-badge" data-tone={statusTone(row.status)}>
                        {row.status ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span className="console-badge" data-tone={statusTone(row.resultStatus)}>
                        {row.resultStatus ?? '—'}
                      </span>
                    </td>
                    <td>
                      <Link to="/console/sessions/$sessionId" params={{ sessionId: row.sessionId }}>
                        {row.sessionTitle ? truncate(row.sessionTitle, 36) : row.sessionId}
                      </Link>
                    </td>
                    <td className="console-mono">{row.durationMs == null ? '—' : `${row.durationMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
