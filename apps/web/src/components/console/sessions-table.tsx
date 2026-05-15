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

export function SessionsTable({ rows, loading }: SessionsTableProps) {
  if (loading && rows.length === 0) {
    return (
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
        <tbody>
          {['skeleton-1', 'skeleton-2', 'skeleton-3', 'skeleton-4', 'skeleton-5'].map((key) => (
            <tr key={key}>
              <td colSpan={7} style={{ color: 'var(--color-text-faint)' }}>
                Loading…
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
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
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
              {formatAbsoluteTime(row.startedAt)}
            </td>
            <td>
              <span
                style={{
                  display: 'inline-block',
                  padding: '2px 6px',
                  borderRadius: 'var(--radius-xs)',
                  border: '1px solid var(--color-border)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-muted)',
                }}
              >
                {row.sourceKind}
              </span>
            </td>
            <td title={row.title ?? ''}>
              <Link
                to="/console/sessions/$sessionId"
                params={{ sessionId: row.id }}
                style={{ color: 'var(--color-text)' }}
              >
                {row.title ? (
                  truncate(row.title, 80)
                ) : (
                  <span style={{ color: 'var(--color-text-faint)' }}>untitled</span>
                )}
              </Link>
            </td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{formatCount(row.messageCount)}</td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{formatCount(row.toolCallCount)}</td>
            <td
              style={{
                fontFamily: 'var(--font-mono)',
                color: row.errorCount > 0 ? 'var(--color-warning)' : 'var(--color-text-muted)',
              }}
            >
              {formatCount(row.errorCount)}
            </td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{formatDuration(row.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
