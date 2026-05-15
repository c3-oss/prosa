import type { FormEvent } from 'react'

import { Button } from '~/components/primitives/button.js'

export const SOURCE_OPTIONS = ['codex', 'claude', 'gemini', 'cursor', 'hermes'] as const

export type SourceKind = (typeof SOURCE_OPTIONS)[number]

export type SessionsFilters = {
  q: string
  sourceKinds: SourceKind[]
  since: string
  until: string
}

export const DEFAULT_FILTERS: SessionsFilters = { q: '', sourceKinds: [], since: '', until: '' }

export type SessionsFilterBarProps = {
  value: SessionsFilters
  onChange: (next: SessionsFilters) => void
}

export function SessionsFilterBar({ value, onChange }: SessionsFilterBarProps) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Form submit is a no-op; the source-of-truth is the live state. Submit just
    // helps screen readers and keyboard users trigger the same flow.
  }

  function toggleSource(kind: SourceKind) {
    const next: SourceKind[] = value.sourceKinds.includes(kind)
      ? value.sourceKinds.filter((k) => k !== kind)
      : [...value.sourceKinds, kind]
    onChange({ ...value, sourceKinds: next })
  }

  function reset() {
    onChange(DEFAULT_FILTERS)
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Session filters"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--space-4)',
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>Search title</span>
        <input
          type="search"
          value={value.q}
          placeholder="title contains…"
          onChange={(e) => onChange({ ...value, q: e.target.value })}
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 10px',
            minWidth: 200,
          }}
        />
      </label>
      <fieldset
        aria-label="Source filter"
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          border: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        <legend
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            marginBottom: 'var(--space-1)',
          }}
        >
          Source
        </legend>
        {SOURCE_OPTIONS.map((kind) => {
          const active = value.sourceKinds.includes(kind)
          return (
            <button
              key={kind}
              type="button"
              onClick={() => toggleSource(kind)}
              aria-pressed={active}
              style={{
                background: active ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
                color: active ? '#04150b' : 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 10px',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-xs)',
                cursor: 'pointer',
              }}
            >
              {kind}
            </button>
          )
        })}
      </fieldset>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>Since</span>
        <input
          type="datetime-local"
          value={value.since}
          onChange={(e) => onChange({ ...value, since: e.target.value })}
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
          }}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>Until</span>
        <input
          type="datetime-local"
          value={value.until}
          onChange={(e) => onChange({ ...value, until: e.target.value })}
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
          }}
        />
      </label>
      <Button type="button" variant="ghost" size="sm" onClick={reset}>
        Reset
      </Button>
    </form>
  )
}
