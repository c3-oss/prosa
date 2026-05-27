// CQ-153 — route-level test for ConsoleSessions calling /v2/reads/*.
//
// Pins that the migrated route fetches against
// `apiV2.v2.sessions.list` + `apiV2.v2.sessions.count` rather than
// the legacy tRPC `api.sessions.*` procedures.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ConsoleSessions } from './sessions.js'

const listSpy = vi.fn(async () => ({
  rows: [
    {
      id: 'sess-1',
      sourceTool: 'codex',
      sourceSessionId: 'src-1',
      projectId: 'p1',
      title: 'My Session',
      summary: null,
      startedAt: '2026-05-20T10:00:00.000Z',
      endedAt: '2026-05-20T10:05:00.000Z',
      status: 'ok',
      storeId: 'store',
      receiptId: 'r1',
      isSubagent: false,
      parentSessionId: null,
      timelineConfidence: 'high',
    },
  ],
  nextCursor: null,
}))

const countSpy = vi.fn(async () => ({ count: 1 }))

const legacySessionsList = vi.fn()
const legacySessionsCount = vi.fn()

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
        sessions: {
          list: { query: legacySessionsList },
          count: { query: legacySessionsCount },
        },
      } as unknown as ReturnType<typeof actual.useAppContext>['api'],
      apiV2: {
        v2: {
          sessions: {
            list: listSpy,
            count: countSpy,
            transcript: vi.fn(),
          },
          search: { query: vi.fn() },
          toolCalls: { list: vi.fn() },
          analytics: { report: vi.fn() },
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
    useSearch: () => ({}),
    useNavigate: () => vi.fn(),
    Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <a {...props}>{children}</a>,
  }
})

function Harness({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('CQ-153 — ConsoleSessions consumes /v2/reads/* (not legacy tRPC)', () => {
  it('calls apiV2.v2.sessions.list + count on render', async () => {
    render(
      <Harness>
        <ConsoleSessions />
      </Harness>,
    )

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalled()
      expect(countSpy).toHaveBeenCalled()
    })

    // Legacy tRPC read procedures must NOT be invoked.
    expect(legacySessionsList).not.toHaveBeenCalled()
    expect(legacySessionsCount).not.toHaveBeenCalled()

    // Default-input shape uses v2 `sourceTools` not v1 `sourceKinds`.
    const firstCall = listSpy.mock.calls[0] as [Record<string, unknown>] | undefined
    expect(firstCall).toBeDefined()
    const listArg = firstCall![0]
    expect(listArg.limit).toBe(50)
    expect(listArg.sourceTools).toBeUndefined() // empty filter
    expect((listArg as { sourceKinds?: unknown }).sourceKinds).toBeUndefined()

    // The migrated row mapping renders the title from the v2 row.
    await waitFor(() => {
      expect(screen.getByText('My Session')).toBeTruthy()
    })
  })
})
