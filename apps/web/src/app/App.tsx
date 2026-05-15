import { WebErrorBoundary } from './error-boundary.js'
import { AppProviders } from './providers.js'
import { AppRouter } from './router.js'

export function App() {
  return (
    <WebErrorBoundary>
      {/*
        AuthProvider is mounted lazily by the auth + console route layouts
        (`AuthSurface`). Public/marketing routes never probe /trpc/auth.me or
        /api/auth/* — the root AppProviders here only owns the tRPC client,
        QueryClient, and runtime config. CQ-002 enforces this boundary.
      */}
      <AppProviders skipAuth>
        <AppRouter />
      </AppProviders>
    </WebErrorBoundary>
  )
}
