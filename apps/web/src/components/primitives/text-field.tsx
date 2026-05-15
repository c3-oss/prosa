import type { InputHTMLAttributes, ReactNode } from 'react'
import { useId } from 'react'

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  description?: ReactNode
  error?: string | null
}

export function TextField(props: TextFieldProps) {
  const { label, description, error, id, style, ...rest } = props
  const generatedId = useId()
  const fieldId = id ?? generatedId
  return (
    <label htmlFor={fieldId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>{label}</span>
      <input
        id={fieldId}
        {...rest}
        style={{
          background: 'var(--color-bg-elevated)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '10px 12px',
          fontSize: 'var(--font-size-base)',
          fontFamily: 'var(--font-ui)',
          ...style,
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
      />
      {description ? (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-faint)' }}>{description}</span>
      ) : null}
      {error ? (
        <span id={`${fieldId}-error`} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)' }}>
          {error}
        </span>
      ) : null}
    </label>
  )
}
