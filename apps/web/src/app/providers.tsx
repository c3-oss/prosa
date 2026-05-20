import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, createContext, useContext, useMemo, useState } from 'react'

import { type V2ApiClient, createV2ApiClient } from '~/lib/api-v2.js'
import { type ProsaTRPCClient, createApiClient } from '~/lib/api.js'
import { type BrowserAuth, createBrowserAuth } from '~/lib/auth.js'
import { type WebRuntimeConfig, loadWebConfig } from '~/lib/config.js'

import { AuthProvider } from './auth-context.js'

type AppContextValue = {
  config: WebRuntimeConfig
  api: ProsaTRPCClient
  /**
   * CQ-153: typed v2 read client for `/v2/reads/*`. Console routes
   * read through this client; the legacy `api` tRPC client stays
   * registered for writes + auth flows until Lane 10 cutover.
   */
  apiV2: V2ApiClient
  auth: BrowserAuth
  tenantId: string | null
  setTenantId: (id: string | null) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppContext must be used inside <AppProviders>')
  return ctx
}

export type AppProvidersProps = {
  children: ReactNode
  /** Override config for tests. */
  config?: WebRuntimeConfig
  /** Override query client for tests. */
  queryClient?: QueryClient
  /**
   * Mount the AuthProvider around the route tree. Set this only for routes
   * that need session state (auth + console). Public/marketing routes leave
   * it false so they never probe `/trpc/auth.me` or `/api/auth/*`.
   */
  skipAuth?: boolean
}

export function AppProviders({
  children,
  config: configOverride,
  queryClient: queryClientOverride,
  skipAuth,
}: AppProvidersProps) {
  const config = useMemo(() => configOverride ?? loadWebConfig(), [configOverride])
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [queryClient] = useState(
    () =>
      queryClientOverride ??
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  )
  const api = useMemo(() => createApiClient({ config, getTenantId: () => tenantId }), [config, tenantId])
  const apiV2 = useMemo(() => createV2ApiClient({ config, getTenantId: () => tenantId }), [config, tenantId])
  const auth = useMemo(() => createBrowserAuth(config), [config])

  const value = useMemo<AppContextValue>(
    () => ({ config, api, apiV2, auth, tenantId, setTenantId }),
    [config, api, apiV2, auth, tenantId],
  )

  return (
    <AppContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>
        {skipAuth ? children : <AuthProvider>{children}</AuthProvider>}
      </QueryClientProvider>
    </AppContext.Provider>
  )
}
