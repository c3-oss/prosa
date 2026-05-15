import { WebErrorBoundary } from './error-boundary.js'
import { AppProviders } from './providers.js'
import { AppRouter } from './router.js'

export function App() {
  return (
    <WebErrorBoundary>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </WebErrorBoundary>
  )
}
