import { Link } from '@tanstack/react-router'

import { formatAbsoluteTime, formatCount, truncate } from '~/lib/format.js'

export type SessionRow = {
  id: string
  sourceKind: string
  title: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  projectId: string | null
  messageCount: number
  toolCallCount: number
  errorCount: number
}

export type SessionsTableProps = {
  rows: SessionRow[]
  loading: boolean
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const remSec = seconds % 60
  if (minutes < 60) return `${minutes}m ${remSec}s`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return `${hours}h ${remMin}m`
}

function LoadingRows() {
  return (
    <tbody>
      {['skeleton-1', 'skeleton-2', 'skeleton-3', 'skeleton-4', 'skeleton-5'].map((key) => (
        <tr key={key}>
          <td colSpan={7} className="console-loading-row">
            <span className="console-skeleton-line" />
          </td>
        </tr>
      ))}
    </tbody>
  )
}

export function SessionsTable({ rows, loading }: SessionsTableProps) {
  return (
    <div className="console-table-wrap">
      <table className="console-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Source</th>
            <th>Title</th>
            <th>Messages</th>
            <th>Tools</th>
            <th>Errors</th>
            <th>Duration</th>
          </tr>
        </thead>
        {loading && rows.length === 0 ? (
          <LoadingRows />
        ) : (
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="console-mono" style={{ whiteSpace: 'nowrap' }}>
                  {formatAbsoluteTime(row.startedAt)}
                </td>
                <td>
                  <span className="console-badge" data-tone="accent">
                    {row.sourceKind}
                  </span>
                </td>
                <td title={row.title ?? ''}>
                  <Link to="/console/sessions/$sessionId" params={{ sessionId: row.id }}>
                    {row.title ? truncate(row.title, 80) : <span className="console-faint">untitled</span>}
                  </Link>
                </td>
                <td className="console-mono">{formatCount(row.messageCount)}</td>
                <td className="console-mono">{formatCount(row.toolCallCount)}</td>
                <td className="console-mono">
                  <span className="console-badge" data-tone={row.errorCount > 0 ? 'warning' : undefined}>
                    {formatCount(row.errorCount)}
                  </span>
                </td>
                <td className="console-mono">{formatDuration(row.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  )
}
