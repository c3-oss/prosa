import type { TimelineEvent } from './timeline-event.js'

export type EventInspectorProps = {
  event: TimelineEvent | null
}

function renderJsonValue(value: unknown): string {
  if (value == null) return 'null'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function EventInspector({ event }: EventInspectorProps) {
  return (
    <aside
      aria-label="Event inspector"
      style={{
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-5)',
        minWidth: 0,
        maxHeight: '70vh',
        overflow: 'auto',
      }}
    >
      <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--font-size-md)' }}>Inspector</h2>
      {!event ? (
        <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-3)' }}>
          Select a timeline event to inspect its payload.
        </p>
      ) : (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 'var(--space-2) var(--space-4)',
            marginTop: 'var(--space-4)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          <dt style={{ color: 'var(--color-text-faint)' }}>id</dt>
          <dd style={{ margin: 0 }}>{event.id}</dd>
          <dt style={{ color: 'var(--color-text-faint)' }}>ordinal</dt>
          <dd style={{ margin: 0 }}>{event.ordinal}</dd>
          <dt style={{ color: 'var(--color-text-faint)' }}>kind</dt>
          <dd style={{ margin: 0 }}>{event.kind}</dd>
          <dt style={{ color: 'var(--color-text-faint)' }}>timestamp</dt>
          <dd style={{ margin: 0 }}>{event.timestamp ?? 'unknown'}</dd>
          <dt style={{ color: 'var(--color-text-faint)' }}>payload</dt>
          <dd style={{ margin: 0 }}>
            <pre
              style={{
                margin: 0,
                background: 'var(--color-code-bg)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-3)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '50vh',
                overflow: 'auto',
              }}
            >
              {renderJsonValue(event.payload)}
            </pre>
          </dd>
        </dl>
      )}
    </aside>
  )
}
