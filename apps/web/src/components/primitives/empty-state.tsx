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
      <p className="console-empty-title">{props.title}</p>
      {props.description ? <p className="console-empty-description">{props.description}</p> : null}
      {props.code ? <code>{props.code}</code> : null}
      {props.action ? <div style={{ marginTop: 'var(--space-4)' }}>{props.action}</div> : null}
    </div>
  )
}
