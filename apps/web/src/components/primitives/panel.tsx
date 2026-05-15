import type { HTMLAttributes, ReactNode } from 'react'

export type PanelProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode
  action?: ReactNode
}

export function Panel(props: PanelProps) {
  const { title, action, children, style, ...rest } = props
  return (
    <section
      {...rest}
      style={{
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        ...style,
      }}
    >
      {title || action ? (
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 'var(--space-4) var(--space-5)',
            borderBottom: '1px solid var(--color-border-subtle)',
          }}
        >
          <h3 style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 'var(--font-size-md)' }}>{title}</h3>
          {action}
        </header>
      ) : null}
      <div style={{ padding: 'var(--space-5)' }}>{children}</div>
    </section>
  )
}
