import type { ReactNode } from 'react'

export type EmptyStateProps = {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  code?: string
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div className="console-empty">
      <p style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--font-size-lg)' }}>{props.title}</p>
      {props.description ? (
        <p style={{ marginTop: 'var(--space-3)', color: 'var(--color-text-muted)' }}>{props.description}</p>
      ) : null}
      {props.code ? <code>{props.code}</code> : null}
      {props.action ? <div style={{ marginTop: 'var(--space-4)' }}>{props.action}</div> : null}
    </div>
  )
}
