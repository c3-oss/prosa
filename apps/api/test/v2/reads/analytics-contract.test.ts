// Lane 6 / CQ-147 — pin the intentional narrowing of the v2
// analytics contract vs. the local `packages/prosa-core` analytics
// service.
//
// The local `runAnalyticsReportFromBundle` / `runAnalyticsReport`
// path in `packages/prosa-core/src/services/analytics.ts` runs over
// SQLite analytics views / DuckDB Parquet exports. Its filter and
// column surface is wider than the Lane 6 read API on purpose:
//
//   - Local filters include `toolName`, `canonicalType`,
//     `errorsOnly`, `category`, `model`, `project`, `sessionId`, and
//     `sourcePathSubstring`. The v2 read API only honours `report`,
//     `sourceTools`, `since`, `until`, and `limit`, and the schema
//     is `.strict()` so any extra key returns HTTP 400
//     `INVALID_CURSOR`-style validation error rather than silently
//     dropping the filter.
//   - Local report rows expose richer columns (e.g.
//     `source_file_path`, `model_last`, `tool_duration_ms`,
//     `timeline_confidence`, per-tool / per-project aggregates,
//     `call_status`, `result_duration_ms`). The v2 read API
//     surfaces the narrower receipt-pinned aggregate set documented
//     in `docs/rearch-2/07-lane-6-read-api.md`.
//
// This file pins the contract so a future drift gets caught:
//
//   - the supported v2 filter keys
//   - the rejection of any local-only filter key at the wire
//     boundary
//   - the supported v2 report names match the local set
//
// CQ-147 acceptance:
//   - "Tests document and pin any intentional difference from the
//     local `packages/prosa-core` analytics report columns and
//     timestamp semantics."

import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_REPORTS as V2_ANALYTICS_REPORTS,
  analyticsReportInput,
} from '../../../src/v2/reads/analytics/report.js'

// Mirror of the local prosa-core service's exported constant. The
// v2 contract intentionally keeps the same five report names but
// narrows everything else. Keeping a manual copy here avoids
// pulling `@c3-oss/prosa-core` into the api package's runtime
// dependency graph just to assert a constant.
const LOCAL_ANALYTICS_REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const

const V2_SUPPORTED_FILTER_KEYS = ['report', 'sourceTools', 'since', 'until', 'limit'] as const

// Local-only filter keys (from
// `packages/prosa-core/src/services/analytics.ts`
// `AnalyticsReportFilters`). The v2 read API rejects each one at
// the wire boundary via the strict() schema.
const LOCAL_ONLY_FILTERS = [
  'source',
  'toolName',
  'canonicalType',
  'errorsOnly',
  'category',
  'model',
  'project',
  'sessionId',
  'sourcePathSubstring',
] as const

describe('Lane 6 analytics — CQ-147 contract narrowing vs local prosa-core', () => {
  it('reports the same five report names as the local prosa-core service', () => {
    expect([...V2_ANALYTICS_REPORTS].sort()).toEqual([...LOCAL_ANALYTICS_REPORTS].sort())
  })

  it('accepts only the documented v2 filter keys', () => {
    // Probe each supported key with a valid value — strict() must
    // accept the bag. Any drift here (new strict-rejected key) is a
    // contract regression.
    const parsed = analyticsReportInput.safeParse({
      report: 'sessions',
      sourceTools: ['codex'],
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-21T00:00:00Z',
      limit: 100,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual([...V2_SUPPORTED_FILTER_KEYS].sort())
    }
  })

  it('rejects every local-only filter key at the v2 wire boundary (CQ-147 strictness)', () => {
    // Each local-only filter must produce a parse failure under the
    // v2 strict schema. The loop also doubles as living documentation
    // of which local filters are explicitly NOT honoured by v2.
    for (const localKey of LOCAL_ONLY_FILTERS) {
      const parsed = analyticsReportInput.safeParse({
        report: 'tools',
        [localKey]: 'whatever',
      })
      expect(parsed.success, `expected v2 schema to reject local-only filter "${localKey}"`).toBe(false)
    }
  })

  it('documents the timestamp semantics difference: v2 uses ISO 8601 strings on the wire (UTC)', () => {
    // The local prosa-core SQL uses report-specific timestamp
    // columns (e.g. `start_ts` for sessions, `timestamp_start` for
    // tools, `timestamp` for errors). The v2 read API normalizes
    // every wire timestamp to ISO 8601 UTC (`to_char(... AT TIME
    // ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`).
    // `since` / `until` are ISO 8601 strings cast server-side to
    // `timestamptz`. This test pins the input contract; the wire
    // shape is pinned by the handler tests.
    const parsed = analyticsReportInput.safeParse({
      report: 'sessions',
      since: '2026-05-19T00:00:00.000Z',
      until: '2026-05-21T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.since).toBe('2026-05-19T00:00:00.000Z')
      expect(parsed.data.until).toBe('2026-05-21T00:00:00.000Z')
    }
  })
})
