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
    <form onSubmit={onSubmit} aria-label="Session filters" className="console-filter-bar">
      <label className="console-field">
        <span className="console-field-label">Search title</span>
        <input
          className="console-input"
          type="search"
          value={value.q}
          placeholder="title contains…"
          onChange={(e) => onChange({ ...value, q: e.target.value })}
          style={{ minWidth: 220 }}
        />
      </label>
      <fieldset aria-label="Source filter" className="console-source-group">
        <legend>Source</legend>
        {SOURCE_OPTIONS.map((kind) => {
          const active = value.sourceKinds.includes(kind)
          return (
            <button
              key={kind}
              type="button"
              className="console-pill-button"
              onClick={() => toggleSource(kind)}
              aria-pressed={active}
            >
              {kind}
            </button>
          )
        })}
      </fieldset>
      <label className="console-field">
        <span className="console-field-label">Since</span>
        <input
          className="console-input"
          type="datetime-local"
          value={value.since}
          onChange={(e) => onChange({ ...value, since: e.target.value })}
        />
      </label>
      <label className="console-field">
        <span className="console-field-label">Until</span>
        <input
          className="console-input"
          type="datetime-local"
          value={value.until}
          onChange={(e) => onChange({ ...value, until: e.target.value })}
        />
      </label>
      <Button type="button" variant="ghost" size="sm" onClick={reset}>
        Reset
      </Button>
    </form>
  )
}
