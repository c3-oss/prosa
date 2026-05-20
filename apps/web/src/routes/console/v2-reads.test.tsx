// CQ-153 — route-level tests for the v2-migrated console routes.
//
// Pins that ConsoleSearch, ConsoleToolCalls, ConsoleAnalytics, and
// ConsoleSessionDetail call `apiV2.v2.*` (not the legacy tRPC
// procedures). Dashboard widgets, artifact route, and the cas-text
// helper remain on tRPC (tracked under the CQ-153 follow-up list).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ConsoleAnalytics } from './analytics.js'
import { ConsoleSearch } from './search.js'
import { ConsoleSessionDetail } from './session-detail.js'
import { ConsoleToolCalls } from './tool-calls.js'

const searchSpy = vi.fn(async () => ({ rows: [], nextCursor: null }))
const toolCallsSpy = vi.fn(async () => ({ rows: [], nextCursor: null }))
const analyticsSpy = vi.fn(async () => ({ report: 'sessions', generatedAt: '2026-05-20T11:00:00.000Z', rows: [] }))
const transcriptSpy = vi.fn(async () => null)

const legacySearch = vi.fn()
const legacyToolCalls = vi.fn()
const legacyAnalytics = vi.fn()
const legacyTranscript = vi.fn()

vi.mock('~/app/auth-context.js', () => ({
  useAuth: () => ({
    me: { tenantId: 'tenant-1' },
    status: 'authenticated' as const,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('~/app/providers.js', async () => {
  const actual = await vi.importActual<typeof import('~/app/providers.js')>('~/app/providers.js')
  return {
    ...actual,
    useAppContext: () => ({
      config: { apiUrl: 'http://127.0.0.1:0', appEnv: 'development', marketingDocsUrl: null, githubUrl: null },
      api: {
        search: { query: { query: legacySearch } },
        toolCalls: { list: { query: legacyToolCalls } },
        analytics: { report: { query: legacyAnalytics } },
        sessions: { transcript: { query: legacyTranscript } },
      } as unknown as ReturnType<typeof actual.useAppContext>['api'],
      apiV2: {
        v2: {
          sessions: { list: vi.fn(), count: vi.fn(), transcript: transcriptSpy },
          search: { query: searchSpy },
          toolCalls: { list: toolCallsSpy },
          analytics: { report: analyticsSpy },
        },
      } as unknown as ReturnType<typeof actual.useAppContext>['apiV2'],
      auth: {} as unknown as ReturnType<typeof actual.useAppContext>['auth'],
      tenantId: 'tenant-1',
      setTenantId: vi.fn(),
    }),
  }
})

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    useSearch: () => ({ q: 'needle' }),
    useNavigate: () => vi.fn(),
    useParams: () => ({ sessionId: 'sess-1' }),
    Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <a {...props}>{children}</a>,
  }
})

function Harness({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('CQ-153 — v2 console routes use apiV2 (not legacy tRPC)', () => {
  it('ConsoleSearch calls apiV2.v2.search.query', async () => {
    render(
      <Harness>
        <ConsoleSearch />
      </Harness>,
    )
    await waitFor(() => expect(searchSpy).toHaveBeenCalled())
    expect(legacySearch).not.toHaveBeenCalled()
    const first = searchSpy.mock.calls[0] as [{ q: string }] | undefined
    expect(first?.[0]?.q).toBe('needle')
  })

  it('ConsoleToolCalls calls apiV2.v2.toolCalls.list', async () => {
    render(
      <Harness>
        <ConsoleToolCalls />
      </Harness>,
    )
    await waitFor(() => expect(toolCallsSpy).toHaveBeenCalled())
    expect(legacyToolCalls).not.toHaveBeenCalled()
  })

  it('ConsoleAnalytics calls apiV2.v2.analytics.report', async () => {
    render(
      <Harness>
        <ConsoleAnalytics />
      </Harness>,
    )
    await waitFor(() => expect(analyticsSpy).toHaveBeenCalled())
    expect(legacyAnalytics).not.toHaveBeenCalled()
    const first = analyticsSpy.mock.calls[0] as [{ report: string }] | undefined
    expect(first?.[0]?.report).toBe('sessions')
  })

  it('ConsoleSessionDetail calls apiV2.v2.sessions.transcript', async () => {
    render(
      <Harness>
        <ConsoleSessionDetail />
      </Harness>,
    )
    await waitFor(() => expect(transcriptSpy).toHaveBeenCalled())
    expect(legacyTranscript).not.toHaveBeenCalled()
    const first = transcriptSpy.mock.calls[0] as [{ sessionId: string; limit: number }] | undefined
    expect(first?.[0]?.sessionId).toBe('sess-1')
    expect(first?.[0]?.limit).toBe(50)
  })
})
