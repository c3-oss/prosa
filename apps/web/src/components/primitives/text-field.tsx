import type { InputHTMLAttributes, ReactNode } from 'react'
import { useId } from 'react'

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  description?: ReactNode
  error?: string | null
}

export function TextField(props: TextFieldProps) {
  const { label, description, error, id, className, ...rest } = props
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const inputClassName = className ? `console-input ${className}` : 'console-input'
  return (
    <label htmlFor={fieldId} className="console-field">
      <span className="console-field-label">{label}</span>
      <input
        id={fieldId}
        {...rest}
        className={inputClassName}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
      />
      {description ? (
        <span className="console-faint" style={{ fontSize: 'var(--font-size-xs)' }}>
          {description}
        </span>
      ) : null}
      {error ? (
        <span id={`${fieldId}-error`} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)' }}>
          {error}
        </span>
      ) : null}
    </label>
  )
}
