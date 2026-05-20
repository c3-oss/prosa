import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ConsoleAnalytics } from './analytics.js'
import { ConsoleSearch } from './search.js'
import { ConsoleToolCalls } from './tool-calls.js'

// CQ-010: every console read route must show a "pick a tenant" empty state
// when no tenant is active, instead of attempting a tenant-scoped query.

vi.mock('~/app/auth-context.js', () => ({
  useAuth: () => ({
    me: null,
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
      api: {} as unknown as ReturnType<typeof actual.useAppContext>['api'],
      apiV2: {} as unknown as ReturnType<typeof actual.useAppContext>['apiV2'],
      auth: {} as unknown as ReturnType<typeof actual.useAppContext>['auth'],
      tenantId: null,
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

describe('console routes — no-tenant empty state', () => {
  it('ConsoleAnalytics shows the pick-a-tenant guidance', () => {
    render(
      <Harness>
        <ConsoleAnalytics />
      </Harness>,
    )
    expect(screen.getByText(/pick a tenant/i)).toBeInTheDocument()
  })

  it('ConsoleSearch shows the pick-a-tenant guidance', () => {
    render(
      <Harness>
        <ConsoleSearch />
      </Harness>,
    )
    expect(screen.getByText(/pick a tenant/i)).toBeInTheDocument()
  })

  it('ConsoleToolCalls shows the pick-a-tenant guidance', () => {
    render(
      <Harness>
        <ConsoleToolCalls />
      </Harness>,
    )
    expect(screen.getByText(/pick a tenant/i)).toBeInTheDocument()
  })
})
