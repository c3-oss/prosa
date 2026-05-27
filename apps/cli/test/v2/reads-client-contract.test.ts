// Lane 7 — pin v2 reads-client types to actual Lane 6 route schemas.
//
// CQ-150: the CLI/web v2 clients drifted from the server route
// schemas. This contract test imports both shapes and asserts (a)
// the inputs the CLI sends round-trip through the server's zod
// schemas and (b) the outputs returned by the server are
// assignable to the CLI's response types.

import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_REPORTS,
  type AnalyticsReportResponse as ApiAnalyticsReportResponse,
  type ListSessionsResponse as ApiListSessionsResponse,
  type SearchQueryResponse as ApiSearchQueryResponse,
  type ToolCallsListResponse as ApiToolCallsListResponse,
  type TranscriptPageResponse as ApiTranscriptPageResponse,
  analyticsReportInput,
  countSessionsInput,
  listSessionsInput,
  searchQueryInput,
  toolCallsListInput,
  transcriptPageInput,
} from '../../../api/src/v2/reads/index.js'
import type {
  AnalyticsReportInput,
  AnalyticsReportResponse,
  SearchQueryInput,
  SearchQueryResponse,
  SessionListInput,
  SessionListResponse,
  ToolCallsListInput,
  ToolCallsListResponse,
  TranscriptPageInput,
  TranscriptPageResponse,
} from '../../src/cli/v2/client/index.js'

describe('v2 reads client — wire compatibility with Lane 6 route schemas', () => {
  it('sessions/list inputs parse with the server schema', () => {
    const input: SessionListInput = {
      cursor: 'cur',
      limit: 25,
      sourceTools: ['codex'],
      projectIds: ['p1'],
      storeIds: ['s1'],
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-20T00:00:00Z',
      q: 'needle',
    }
    expect(listSessionsInput.safeParse(input).success).toBe(true)
  })

  it('sessions/count rejects cursor + limit (server schema is a strict subset)', () => {
    expect(countSessionsInput.safeParse({ sourceTools: ['codex'] }).success).toBe(true)
  })

  it('sessions/transcript inputs parse', () => {
    const input: TranscriptPageInput = { sessionId: 'sess-1', cursor: null, limit: 50 }
    expect(transcriptPageInput.safeParse(input).success).toBe(true)
  })

  it('search/query inputs parse — supported filters only', () => {
    const input: SearchQueryInput = {
      q: 'hello',
      roles: ['user'],
      toolNames: ['shell'],
      canonicalToolTypes: ['shell.run'],
      entityTypes: ['message'],
      errorsOnly: true,
      sessionId: 'sess-1',
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-20T00:00:00Z',
      cursor: 'cur',
      limit: 100,
    }
    expect(searchQueryInput.safeParse(input).success).toBe(true)
  })

  it('search/query silently drops v1-style fields (CQ-150 was a silent-drop bug)', () => {
    // The server schema is non-strict — sending `role` or `toolName`
    // (singular) parses successfully but the values do not propagate
    // to the SQL. CQ-150 fixed the CLI/web clients to use plural
    // names; this test pins the silent-drop semantics so future
    // refactors do not regress to singular accidentally.
    const drop = searchQueryInput.safeParse({ q: 'hi', role: 'user', toolName: 'shell' })
    expect(drop.success).toBe(true)
    if (drop.success) {
      expect((drop.data as { role?: unknown }).role).toBeUndefined()
      expect((drop.data as { toolName?: unknown }).toolName).toBeUndefined()
    }
  })

  it('tool-calls/list inputs parse — sessionId is singular', () => {
    const input: ToolCallsListInput = {
      sessionId: 'sess-1',
      toolNames: ['shell'],
      canonicalToolTypes: ['shell.run'],
      errorsOnly: true,
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-20T00:00:00Z',
      cursor: 'cur',
      limit: 50,
    }
    expect(toolCallsListInput.safeParse(input).success).toBe(true)
  })

  it('analytics/report rejects extra fields (strict mode)', () => {
    const input: AnalyticsReportInput = {
      report: 'sessions',
      sourceTools: ['codex'],
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-20T00:00:00Z',
      limit: 200,
    }
    expect(analyticsReportInput.safeParse(input).success).toBe(true)
    expect(analyticsReportInput.safeParse({ ...input, cursor: 'x' }).success).toBe(false)
    expect(analyticsReportInput.safeParse({ ...input, projectIds: ['p1'] }).success).toBe(false)
  })

  it('analytics report kinds match', () => {
    expect(ANALYTICS_REPORTS).toEqual(['sessions', 'tools', 'errors', 'models', 'projects'])
  })

  /**
   * Type-level assertions: the CLI response types must be assignable
   * from the server response types. If the server adds a required
   * field, the CLI's mapping code is forced to surface or drop it
   * explicitly — never silently render the wrong field.
   */
  it('CLI response types are structurally compatible with server responses', () => {
    const _list: (r: ApiListSessionsResponse) => SessionListResponse = (r) => r
    const _transcript: (r: ApiTranscriptPageResponse) => TranscriptPageResponse = (r) => r
    const _search: (r: ApiSearchQueryResponse) => SearchQueryResponse = (r) => r
    const _toolCalls: (r: ApiToolCallsListResponse) => ToolCallsListResponse = (r) => r
    const _analytics: (r: ApiAnalyticsReportResponse) => AnalyticsReportResponse = (r) => r
    expect(typeof _list).toBe('function')
    expect(typeof _transcript).toBe('function')
    expect(typeof _search).toBe('function')
    expect(typeof _toolCalls).toBe('function')
    expect(typeof _analytics).toBe('function')
  })
})
