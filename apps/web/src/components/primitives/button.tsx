import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

const variantStyle: Record<ButtonVariant, Record<string, string>> = {
  primary: {
    background: 'var(--color-accent)',
    color: '#04150b',
    borderColor: 'var(--color-accent)',
  },
  secondary: {
    background: 'var(--color-panel-strong)',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-text-muted)',
    borderColor: 'transparent',
  },
  danger: {
    background: 'var(--color-danger)',
    color: '#0c0303',
    borderColor: 'var(--color-danger)',
  },
}

const sizeStyle: Record<ButtonSize, Record<string, string>> = {
  sm: { padding: '6px 10px', fontSize: 'var(--font-size-sm)' },
  md: { padding: '10px 14px', fontSize: 'var(--font-size-base)' },
}

export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md', style, type = 'button', children, ...rest } = props
  const composedStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
    border: '1px solid',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-ui)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background var(--motion-fast) var(--easing-standard)',
    ...variantStyle[variant],
    ...sizeStyle[size],
    ...style,
  }
  return (
    <button {...rest} type={type} style={composedStyle}>
      {children}
    </button>
  )
}
