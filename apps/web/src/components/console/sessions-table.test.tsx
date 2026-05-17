import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '~/test/render.js'

import { type SessionRow, SessionsTable } from './sessions-table.js'

function buildRouter(ui: () => ReactElement) {
  const rootRoute = createRootRoute({ component: ui })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ui })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/console/sessions/$sessionId',
    component: () => null,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

const fixture: SessionRow[] = [
  {
    id: 'sess-a',
    sourceKind: 'codex',
    title: 'compile bundle',
    startedAt: '2026-04-01T10:00:00Z',
    endedAt: '2026-04-01T10:01:30Z',
    durationMs: 90_000,
    projectId: null,
    messageCount: 12,
    toolCallCount: 4,
    errorCount: 1,
  },
  {
    id: 'sess-b',
    sourceKind: 'claude',
    title: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    projectId: null,
    messageCount: 0,
    toolCallCount: 0,
    errorCount: 0,
  },
]

describe('SessionsTable', () => {
  it('renders rows with source badges and titled cells', async () => {
    const router = buildRouter(() => <SessionsTable rows={fixture} loading={false} />)
    const { findByText, getByText } = renderWithProviders(<RouterProvider router={router} />)
    await findByText('compile bundle')
    expect(getByText('codex')).toBeInTheDocument()
    expect(getByText('claude')).toBeInTheDocument()
    // Untitled row renders the placeholder text.
    expect(getByText('untitled')).toBeInTheDocument()
  })

  it('renders a loading skeleton when loading and rows empty', async () => {
    const router = buildRouter(() => <SessionsTable rows={[]} loading={true} />)
    const { container } = renderWithProviders(<RouterProvider router={router} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.console-loading-row')).toHaveLength(5)
      expect(container.querySelectorAll('.console-skeleton-line')).toHaveLength(5)
    })
  })
})
