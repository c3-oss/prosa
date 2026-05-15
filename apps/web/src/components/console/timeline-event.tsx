import { formatAbsoluteTime, truncate } from '~/lib/format.js'

export type TimelineEventKind = 'message' | 'toolCall' | 'toolResult' | 'artifact' | 'system' | 'edge' | 'unknown'

export type TimelineEvent = {
  id: string
  ordinal: number
  timestamp: string | null
  kind: string
  payload?: unknown
}

const kindStyle: Record<TimelineEventKind, { accent: string; label: string }> = {
  message: { accent: 'var(--color-accent)', label: 'message' },
  toolCall: { accent: 'var(--color-cyan)', label: 'tool call' },
  toolResult: { accent: 'var(--color-cyan)', label: 'tool result' },
  artifact: { accent: 'var(--color-warning)', label: 'artifact' },
  system: { accent: 'var(--color-text-muted)', label: 'system' },
  edge: { accent: 'var(--color-text-muted)', label: 'edge' },
  unknown: { accent: 'var(--color-danger)', label: 'unknown' },
}

function knownKind(value: string): TimelineEventKind {
  if (value in kindStyle) return value as TimelineEventKind
  return 'unknown'
}

function renderPayloadPreview(payload: unknown): string {
  if (payload == null) return ''
  if (typeof payload === 'string') return truncate(payload, 240)
  try {
    return truncate(JSON.stringify(payload), 240)
  } catch {
    return ''
  }
}

export type TimelineEventCardProps = {
  event: TimelineEvent
  selected: boolean
  onSelect: () => void
}

export function TimelineEventCard({ event, selected, onSelect }: TimelineEventCardProps) {
  const kind = knownKind(event.kind)
  const style = kindStyle[kind]
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        background: selected ? 'var(--color-panel-strong)' : 'var(--color-panel)',
        border: '1px solid var(--color-border-subtle)',
        borderLeft: `3px solid ${style.accent}`,
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-3) var(--space-4)',
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-faint)',
        }}
      >
        <span>
          #{event.ordinal} · {style.label}
        </span>
        <span>{formatAbsoluteTime(event.timestamp)}</span>
      </header>
      <pre
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {renderPayloadPreview(event.payload) || (
          <span style={{ color: 'var(--color-text-faint)' }}>no preview available</span>
        )}
      </pre>
    </button>
  )
}
