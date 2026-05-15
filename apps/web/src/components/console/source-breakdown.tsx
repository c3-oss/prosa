import { Panel } from '~/components/primitives/panel.js'

export type SourceBreakdownProps = {
  sources: Array<{ sourceKind: string; count: number }>
}

export function SourceBreakdown({ sources }: SourceBreakdownProps) {
  const total = sources.reduce((sum, row) => sum + row.count, 0)
  return (
    <Panel title="Source breakdown">
      {sources.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>No promoted sessions yet.</p>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', margin: 0, padding: 0 }}>
          {sources.map((row) => {
            const percentage = total === 0 ? 0 : Math.round((row.count / total) * 100)
            return (
              <li
                key={row.sourceKind}
                style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-sm)',
                  }}
                >
                  <span>{row.sourceKind}</span>
                  <span style={{ color: 'var(--color-text-faint)' }}>
                    {row.count} · {percentage}%
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  style={{
                    height: 4,
                    background: 'var(--color-bg-elevated)',
                    borderRadius: 'var(--radius-xs)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${percentage}%`,
                      background: 'var(--color-accent)',
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
