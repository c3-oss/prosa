import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

import { AuthLayout } from '~/routes/auth/layout.js'
import { LoginPage } from '~/routes/auth/login.js'
import { SignupPage } from '~/routes/auth/signup.js'
import { ConsoleAnalytics } from '~/routes/console/analytics.js'
import { ConsoleDashboard } from '~/routes/console/dashboard.js'
import { ConsoleLayout } from '~/routes/console/layout.js'
import { ConsoleSearch } from '~/routes/console/search.js'
import { ConsoleSessionDetail } from '~/routes/console/session-detail.js'
import { ConsoleSessions } from '~/routes/console/sessions.js'
import { ConsoleSettings } from '~/routes/console/settings.js'
import { ConsoleToolCalls } from '~/routes/console/tool-calls.js'
import { DocsPage } from '~/routes/marketing/docs.js'
import { LandingPage } from '~/routes/marketing/landing.js'
import { MarketingLayout } from '~/routes/marketing/layout.js'
import { ProductPage } from '~/routes/marketing/product.js'
import { SecurityPage } from '~/routes/marketing/security.js'

const rootRoute = createRootRoute({ component: () => <Outlet /> })

const marketingRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'marketing',
  component: MarketingLayout,
})

const landingRoute = createRoute({
  getParentRoute: () => marketingRoute,
  path: '/',
  component: LandingPage,
})

const productRoute = createRoute({
  getParentRoute: () => marketingRoute,
  path: '/product',
  component: ProductPage,
})

const securityRoute = createRoute({
  getParentRoute: () => marketingRoute,
  path: '/security',
  component: SecurityPage,
})

const docsRoute = createRoute({
  getParentRoute: () => marketingRoute,
  path: '/docs',
  component: DocsPage,
})

const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  component: AuthLayout,
})

const loginRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/login',
  component: LoginPage,
})

const signupRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/signup',
  component: SignupPage,
})

const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console',
  component: ConsoleLayout,
})

const consoleDashboardRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/',
  component: ConsoleDashboard,
})

const consoleSessionsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/sessions',
  component: ConsoleSessions,
})

const consoleSessionDetailRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/sessions/$sessionId',
  component: ConsoleSessionDetail,
})

const consoleSearchRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/search',
  component: ConsoleSearch,
})

const consoleToolCallsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/tool-calls',
  component: ConsoleToolCalls,
})

const consoleAnalyticsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/analytics',
  component: ConsoleAnalytics,
})

const consoleSettingsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/settings/$section',
  component: ConsoleSettings,
})

export const routeTree = rootRoute.addChildren([
  marketingRoute.addChildren([landingRoute, productRoute, securityRoute, docsRoute]),
  authRoute.addChildren([loginRoute, signupRoute]),
  consoleRoute.addChildren([
    consoleDashboardRoute,
    consoleSessionsRoute,
    consoleSessionDetailRoute,
    consoleSearchRoute,
    consoleToolCallsRoute,
    consoleAnalyticsRoute,
    consoleSettingsRoute,
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />
}
