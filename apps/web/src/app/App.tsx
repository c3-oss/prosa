import { AppProviders } from './providers.js'
import { AppRouter } from './router.js'

export function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  )
}
