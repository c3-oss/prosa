// Analytics execution plan composition tests.
//
// `planAnalyticsExecution` is a pure data-shape composer: given a
// bundle root + view name (+ optional report query), it returns the
// ordered statement sequence a runtime DuckDB executor consumes. The
// tests exercise the composition contract — they do not execute any
// SQL.

import { describe, expect, it } from 'vitest'

import { planAnalyticsExecution } from '../../src/analytics/executor-plan.js'
import {
  ANALYTICS_ENTITY_TABLES,
  ANALYTICS_VIEW_COLUMNS,
  ANALYTICS_VIEW_NAMES,
  type AnalyticsViewName,
  analyticsViewSql,
} from '../../src/analytics/views.js'

const BUNDLE_ROOT = '/tmp/test-bundle'

describe('planAnalyticsExecution', () => {
  it('returns the canonical column-shape contract for the requested view', () => {
    for (const view of ANALYTICS_VIEW_NAMES) {
      const plan = planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view })
      expect(plan.view).toBe(view)
      expect(plan.columns).toBe(ANALYTICS_VIEW_COLUMNS[view])
    }
  })

  it('emits one preamble statement per canonical entity, followed by the view body', () => {
    const plan = planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view: 'session_facts' })
    // Preamble + 1 view body.
    expect(plan.setupStatements).toHaveLength(ANALYTICS_ENTITY_TABLES.length + 1)
    // Preamble entries in canonical entity order.
    for (let i = 0; i < ANALYTICS_ENTITY_TABLES.length; i++) {
      const entity = ANALYTICS_ENTITY_TABLES[i]!
      const stmt = plan.setupStatements[i]!
      expect(stmt).toContain(`CREATE OR REPLACE TEMP VIEW ${entity} AS`)
      expect(stmt).toContain('read_parquet([')
      expect(stmt).toContain('union_by_name => true')
      expect(stmt.endsWith(';')).toBe(true)
    }
    // Final entry is the analytics view body.
    const viewStmt = plan.setupStatements.at(-1)!
    expect(viewStmt).toContain('CREATE OR REPLACE VIEW session_facts AS')
    expect(viewStmt.endsWith(';')).toBe(true)
  })

  it('emits exactly the SQL body returned by analyticsViewSql, terminated with one semicolon', () => {
    for (const view of ANALYTICS_VIEW_NAMES) {
      const plan = planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view })
      const body = analyticsViewSql(view)
      const expected = body.endsWith(';') ? body : `${body};`
      expect(plan.setupStatements.at(-1)).toBe(expected)
    }
  })

  it('defaults the report query to `SELECT * FROM <view>;`', () => {
    for (const view of ANALYTICS_VIEW_NAMES) {
      const plan = planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view })
      expect(plan.reportQuery).toBe(`SELECT * FROM ${view};`)
    }
  })

  it('passes a custom report query through verbatim, with no rewriting', () => {
    const custom = 'SELECT project_name, count(*) AS n FROM project_activity GROUP BY project_name;'
    const plan = planAnalyticsExecution({
      bundleRoot: BUNDLE_ROOT,
      view: 'project_activity',
      reportQuery: custom,
    })
    expect(plan.reportQuery).toBe(custom)
  })

  it('binds the bundle root into every preamble Parquet glob with both live and compacted overlays', () => {
    const plan = planAnalyticsExecution({ bundleRoot: '/some/bundle', view: 'session_facts' })
    for (let i = 0; i < ANALYTICS_ENTITY_TABLES.length; i++) {
      const entity = ANALYTICS_ENTITY_TABLES[i]!
      const stmt = plan.setupStatements[i]!
      expect(stmt).toContain(`/some/bundle/epochs/*/projection/${entity}.parquet`)
      expect(stmt).toContain(`/some/bundle/epochs/compact-*/projection/${entity}.compacted.parquet`)
    }
  })

  it('throws on an unknown view name with the list of valid names', () => {
    expect(() =>
      planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view: 'totally_made_up' as AnalyticsViewName }),
    ).toThrow(/unknown view.*session_facts.*tool_usage_facts.*error_facts.*model_usage.*project_activity/)
  })

  it('is deterministic — repeated calls with the same input return identical setupStatements', () => {
    const a = planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view: 'tool_usage_facts' })
    const b = planAnalyticsExecution({ bundleRoot: BUNDLE_ROOT, view: 'tool_usage_facts' })
    expect(a.setupStatements).toEqual(b.setupStatements)
    expect(a.reportQuery).toBe(b.reportQuery)
    expect(a.columns).toBe(b.columns)
  })

  it('escapes single quotes in the bundle root path to keep the generated SQL safe', () => {
    const plan = planAnalyticsExecution({ bundleRoot: "/tmp/o'malley", view: 'session_facts' })
    for (let i = 0; i < ANALYTICS_ENTITY_TABLES.length; i++) {
      const stmt = plan.setupStatements[i]!
      // The path appears as an SQL string literal; single quotes
      // must be doubled, not left raw.
      expect(stmt).toContain("o''malley")
      expect(stmt).not.toMatch(/o'malley[^']/)
    }
  })
})
