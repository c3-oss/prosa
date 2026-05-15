import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '~/test/render.js'

import { LandingPage } from './landing.js'

function buildLandingRouter() {
  const rootRoute = createRootRoute({ component: LandingPage })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: LandingPage })
  const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: () => null })
  const productRoute = createRoute({ getParentRoute: () => rootRoute, path: '/product', component: () => null })
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, signupRoute, productRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

describe('LandingPage', () => {
  it('renders without API availability', async () => {
    const router = buildLandingRouter()
    const { findByRole } = renderWithProviders(<RouterProvider router={router} />)
    const heading = await findByRole('heading', {
      name: /searchable console for agent session history/i,
    })
    expect(heading).toBeInTheDocument()
  })
})
