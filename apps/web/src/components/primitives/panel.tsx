import type { HTMLAttributes, ReactNode } from 'react'

export type PanelProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode
  action?: ReactNode
}

export function Panel(props: PanelProps) {
  const { title, action, children, className, ...rest } = props
  const composedClassName = className ? `console-panel ${className}` : 'console-panel'
  return (
    <section {...rest} className={composedClassName}>
      {title || action ? (
        <header className="console-panel-header">
          <h3 className="console-panel-title">{title}</h3>
          {action}
        </header>
      ) : null}
      <div className="console-panel-body">{children}</div>
    </section>
  )
}
