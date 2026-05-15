import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, createContext, useContext, useMemo, useState } from 'react'

import { type ProsaTRPCClient, createApiClient } from '~/lib/api.js'
import { type BrowserAuth, createBrowserAuth } from '~/lib/auth.js'
import { type WebRuntimeConfig, loadWebConfig } from '~/lib/config.js'

import { AuthProvider } from './auth-context.js'

type AppContextValue = {
  config: WebRuntimeConfig
  api: ProsaTRPCClient
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
  /** Skip the AuthProvider — useful for primitive tests that don't need session state. */
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
  const auth = useMemo(() => createBrowserAuth(config), [config])

  const value = useMemo<AppContextValue>(
    () => ({ config, api, auth, tenantId, setTenantId }),
    [config, api, auth, tenantId],
  )

  return (
    <AppContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>
        {skipAuth ? children : <AuthProvider>{children}</AuthProvider>}
      </QueryClientProvider>
    </AppContext.Provider>
  )
}
