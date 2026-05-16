import { SlidersHorizontal } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'

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

// Count active filter facets so the toolbar trigger can surface a badge without
// re-deriving the predicate logic in every caller.
export function countActiveFilters(filters: SessionsFilters): number {
  return (filters.q !== '' ? 1 : 0) + filters.sourceKinds.length + (filters.since ? 1 : 0) + (filters.until ? 1 : 0)
}

export type SessionsFilterToolbarProps = {
  open: boolean
  onToggle: () => void
  activeCount: number
  right?: ReactNode
}

export function SessionsFilterToolbar({ open, onToggle, activeCount, right }: SessionsFilterToolbarProps) {
  return (
    <div className="console-filters-toolbar">
      <button
        type="button"
        className="console-filters-trigger"
        aria-expanded={open}
        aria-controls="sessions-filters"
        onClick={onToggle}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>Filters</span>
        {activeCount > 0 ? <span className="console-filters-count-badge">{activeCount}</span> : null}
      </button>
      {right ? <div className="console-filters-right">{right}</div> : null}
    </div>
  )
}

export type SessionsFilterBarProps = {
  value: SessionsFilters
  onChange: (next: SessionsFilters) => void
  open: boolean
}

export function SessionsFilterBar({ value, onChange, open }: SessionsFilterBarProps) {
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
    <form
      id="sessions-filters"
      data-open={open ? 'true' : undefined}
      onSubmit={onSubmit}
      aria-label="Session filters"
      className="console-filter-bar"
    >
      <input
        className="console-input"
        type="search"
        value={value.q}
        placeholder="Search title…"
        aria-label="Search title"
        onChange={(e) => onChange({ ...value, q: e.target.value })}
        style={{ minWidth: 220 }}
      />
      <fieldset aria-label="Source filter" className="console-source-group">
        <legend className="console-sr-only">Source</legend>
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
      <div className="console-field-inline">
        <span aria-hidden="true" className="console-field-prefix">
          Since
        </span>
        <input
          className="console-input"
          type="datetime-local"
          value={value.since}
          aria-label="Since"
          onChange={(e) => onChange({ ...value, since: e.target.value })}
        />
      </div>
      <div className="console-field-inline">
        <span aria-hidden="true" className="console-field-prefix">
          Until
        </span>
        <input
          className="console-input"
          type="datetime-local"
          value={value.until}
          aria-label="Until"
          onChange={(e) => onChange({ ...value, until: e.target.value })}
        />
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={reset}>
        Reset
      </Button>
    </form>
  )
}
