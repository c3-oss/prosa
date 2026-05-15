import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from './auth-context.js'
import { useAppContext } from './providers.js'

const TEST_CONFIG = {
  apiUrl: 'http://127.0.0.1:0',
  appEnv: 'development' as const,
  marketingDocsUrl: null,
  githubUrl: null,
}

function buildContextWith(meQuery: () => Promise<unknown>) {
  return {
    config: TEST_CONFIG,
    api: { auth: { me: { query: meQuery } } } as unknown as ReturnType<typeof useAppContext>['api'],
    auth: {} as ReturnType<typeof useAppContext>['auth'],
    tenantId: null,
    setTenantId: () => undefined,
  }
}

vi.mock('./providers.js', async () => {
  const actual = await vi.importActual<typeof import('./providers.js')>('./providers.js')
  return {
    ...actual,
    useAppContext: vi.fn(),
  }
})

function harness(children: ReactNode, ctx: ReturnType<typeof buildContextWith>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  vi.mocked(useAppContext).mockReturnValue(ctx as unknown as ReturnType<typeof useAppContext>)
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>,
  )
}

function Probe() {
  const auth = useAuth()
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="email">{auth.me?.user.email ?? ''}</span>
      <span data-testid="tenant">{auth.me?.tenantId ?? ''}</span>
    </div>
  )
}

describe('AuthProvider', () => {
  it('reports authenticated status when auth.me returns a session', async () => {
    const ctx = buildContextWith(async () => ({
      user: { id: 'u1', email: 'alice@example.com', name: 'Alice' },
      session: null,
      tenantId: 'org-1',
      memberRole: 'admin',
      tenants: [{ id: 'org-1', name: 'Acme', slug: 'acme', role: 'admin' }],
    }))
    const { getByTestId } = harness(<Probe />, ctx)
    await waitFor(() => expect(getByTestId('status').textContent).toBe('authenticated'))
    expect(getByTestId('email').textContent).toBe('alice@example.com')
    expect(getByTestId('tenant').textContent).toBe('org-1')
  })

  it('reports unauthenticated when auth.me throws an UNAUTHORIZED tRPC error', async () => {
    const ctx = buildContextWith(async () => {
      const err = new Error('Authentication required') as Error & { data: { httpStatus: number; code: string } }
      err.data = { httpStatus: 401, code: 'UNAUTHORIZED' }
      throw err
    })
    const { getByTestId } = harness(<Probe />, ctx)
    await waitFor(() => expect(getByTestId('status').textContent).toBe('unauthenticated'))
    expect(getByTestId('email').textContent).toBe('')
  })
})
