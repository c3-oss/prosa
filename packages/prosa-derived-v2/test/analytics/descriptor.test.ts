// Analytics views descriptor tests.
//
// `analyticsViewsDescriptor()` packages `ANALYTICS_VIEW_NAMES` +
// `ANALYTICS_VIEW_COLUMNS` + `analyticsViewSql()` into one queryable
// catalog shape for MCP / CLI consumers. `analyticsViewDescriptor`
// returns a single record by name.

import { describe, expect, it } from 'vitest'

import { analyticsViewDescriptor, analyticsViewsDescriptor } from '../../src/analytics/descriptor.js'
import { ANALYTICS_VIEW_COLUMNS, ANALYTICS_VIEW_NAMES, analyticsViewSql } from '../../src/analytics/views.js'

describe('analyticsViewDescriptor', () => {
  it('returns name + columns + sql for each canonical view', () => {
    for (const name of ANALYTICS_VIEW_NAMES) {
      const descriptor = analyticsViewDescriptor(name)
      expect(descriptor.name).toBe(name)
      expect(descriptor.columns).toBe(ANALYTICS_VIEW_COLUMNS[name])
      expect(descriptor.sql).toBe(analyticsViewSql(name))
    }
  })

  it('throws on an unknown view name (mirrors analyticsViewSql strict policy)', () => {
    expect(() => {
      // @ts-expect-error — testing runtime guard against typed misuse.
      analyticsViewDescriptor('not_a_real_view')
    }).toThrow()
  })

  it('produces a fresh object on each call (no shared mutable state)', () => {
    const first = analyticsViewDescriptor('session_facts')
    const second = analyticsViewDescriptor('session_facts')
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })
})

describe('analyticsViewsDescriptor', () => {
  it('returns one descriptor per analytics view, in canonical name order', () => {
    const descriptors = analyticsViewsDescriptor()
    expect(descriptors.map((d) => d.name)).toEqual([...ANALYTICS_VIEW_NAMES])
  })

  it('each descriptor exposes the canonical columns and SQL', () => {
    const descriptors = analyticsViewsDescriptor()
    for (const descriptor of descriptors) {
      expect(descriptor.columns).toBe(ANALYTICS_VIEW_COLUMNS[descriptor.name])
      expect(descriptor.sql).toBe(analyticsViewSql(descriptor.name))
      expect(descriptor.sql.length).toBeGreaterThan(0)
    }
  })

  it('the result array length matches ANALYTICS_VIEW_NAMES.length (no extra/missing rows)', () => {
    expect(analyticsViewsDescriptor()).toHaveLength(ANALYTICS_VIEW_NAMES.length)
  })

  it('returns a fresh array on each call (caller can safely mutate it without affecting callers)', () => {
    const a = analyticsViewsDescriptor()
    const b = analyticsViewsDescriptor()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
    // Each element should also be a fresh object.
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).not.toBe(b[i])
    }
  })

  it('every column array is the frozen canonical reference (no per-call allocations)', () => {
    const descriptors = analyticsViewsDescriptor()
    for (const descriptor of descriptors) {
      // The descriptor's `columns` is the same reference as the
      // canonical export — no defensive copy. Callers that need a
      // mutable array do their own copy.
      expect(descriptor.columns).toBe(ANALYTICS_VIEW_COLUMNS[descriptor.name])
    }
  })
})
