import { Panel } from '~/components/primitives/panel.js'

export type SourceBreakdownProps = {
  sources: Array<{ sourceKind: string; count: number }>
}

export function SourceBreakdown({ sources }: SourceBreakdownProps) {
  const total = sources.reduce((sum, row) => sum + row.count, 0)
  return (
    <Panel title="Source breakdown">
      {sources.length === 0 ? (
        <p className="console-muted" style={{ margin: 0 }}>
          No promoted sessions yet.
        </p>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', margin: 0, padding: 0 }}>
          {sources.map((row) => {
            const percentage = total === 0 ? 0 : Math.round((row.count / total) * 100)
            return (
              <li
                key={row.sourceKind}
                style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="console-badge" data-tone="accent">
                    {row.sourceKind}
                  </span>
                  <span className="console-mono console-faint">
                    {row.count} · {percentage}%
                  </span>
                </div>
                <div className="console-progress-track" aria-hidden="true">
                  <div className="console-progress-value" style={{ width: `${percentage}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
