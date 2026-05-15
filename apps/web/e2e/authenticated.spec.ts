import { expect, test } from '@playwright/test'

/**
 * CQ-001: prove the authenticated browser flow end-to-end against a real
 * API. The Playwright config boots a PGlite-backed apps/api on port 3030
 * with PROSA_WEB_ORIGIN pointing at the Vite dev server.
 */

const uniqueSlug = () => `e2e-${Math.random().toString(36).slice(2, 10)}`

const API_URL = process.env.PROSA_API_PORT ? `http://127.0.0.1:${process.env.PROSA_API_PORT}` : 'http://127.0.0.1:3030'

type TrpcResult<T> = { result: { data: T } }

test('signup → seed promoted session → console reads → search-fail-closed → logout', async ({ page, request }) => {
  test.setTimeout(120_000)

  const slug = uniqueSlug()
  const email = `${slug}@e2e.prosa.dev`

  // ---- 1. Signup. Lands on the console with empty data. ----
  await page.goto('/signup')
  await page.locator('input[autocomplete="name"]').fill('E2E User')
  await page.locator('input[autocomplete="email"]').fill(email)
  await page.locator('input[autocomplete="new-password"]').fill('correct-horse-battery')
  await page.locator('input[type="text"]:not([autocomplete]), input:not([type]):not([autocomplete])').first().fill(slug)
  await page.locator('input[type="text"]:not([autocomplete]), input:not([type]):not([autocomplete])').nth(1).fill(slug)
  await page.getByRole('button', { name: 'Create account' }).click()

  await page.waitForURL('**/console')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('No promoted sessions yet.').first()).toBeVisible()

  // ---- 2. Seed a verified promoted session via the sync API. ----
  // We reuse the cookie session set during signup (browser context). Each
  // tRPC mutation uses the same fetch with `credentials: 'include'` semantics
  // that Playwright's `request` fixture inherits from the page context.
  const cookies = await page.context().cookies()
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  async function trpcMutate<T>(path: string, body: unknown): Promise<T> {
    const resp = await request.post(`${API_URL}/trpc/${path}`, {
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      data: body,
    })
    expect(resp.status(), `${path} response`).toBe(200)
    const parsed = (await resp.json()) as TrpcResult<T>
    return parsed.result.data
  }

  const handshake = await trpcMutate<{ deviceId: string }>('sync.handshake', {
    cliVersion: '0.0.0-e2e',
    device: { name: 'e2e-device', platform: 'browser' },
    store: { path: '/tmp/.prosa-e2e', bundleVersion: '1' },
  })

  const plan = await trpcMutate<{ batchId: string }>('sync.planUpload', {
    deviceId: handshake.deviceId,
    storePath: '/tmp/.prosa-e2e',
    objects: [],
  })

  const sessionId = `sess-${slug}`
  const docId = `doc-${slug}`
  await trpcMutate('sync.commitUpload', {
    batchId: plan.batchId,
    deviceId: handshake.deviceId,
    storePath: '/tmp/.prosa-e2e',
    objects: [],
    projection: {
      sessions: [
        {
          id: sessionId,
          sourceKind: 'codex',
          title: 'verified e2e session',
          turnCount: 3,
          startedAt: '2026-05-15T10:00:00Z',
          endedAt: '2026-05-15T10:05:00Z',
        },
      ],
      searchDocs: [
        { id: docId, sessionId, kind: 'session', body: 'verified e2e search body for the playwright suite' },
      ],
    },
  })

  await trpcMutate('sync.verifyPromotion', {
    batchId: plan.batchId,
    storePath: '/tmp/.prosa-e2e',
    declaredSessionIds: [sessionId],
    declaredSearchDocIds: [docId],
  })

  // ---- 3. Reload console and observe real promoted data. ----
  await page.goto('/console/sessions')
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible()
  await expect(page.getByRole('link', { name: /verified e2e session/i })).toBeVisible()

  // ---- 4. Open session detail. Header shows the title; events are
  //         intentionally empty per CQ-004 fail-closed.
  await page.getByRole('link', { name: /verified e2e session/i }).click()
  await page.waitForURL(`**/console/sessions/${sessionId}`)
  await expect(page.getByRole('heading', { name: /verified e2e session/i })).toBeVisible()
  await expect(page.getByText(/no events yet/i)).toBeVisible()

  // ---- 5. Analytics: every report kind fails closed in v0 (CQ-006).
  // The default tab is `sessions`; the page should surface the
  // EmptyState error banner instead of any auxiliary report rows.
  await page.goto('/console/analytics')
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()
  await expect(page.getByText(/could not load|not[_ ]implemented|unavailable/i).first()).toBeVisible()

  // ---- 6. Search: must fail closed end-to-end (CQ-005).
  await page.goto('/console/search')
  await page.locator('input[type="search"]').fill('verified')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByText(/search failed|not[_ ]implemented|unavailable/i).first()).toBeVisible()

  // ---- 7. Sign out → fail-closed redirect to /login.
  await page.goto('/console')
  await page.getByRole('button', { name: /sign out/i }).click()
  await page.waitForURL('**/login')
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()

  // ---- 8. Login as the existing user. Lands back in the console.
  await page.locator('input[autocomplete="email"]').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/console')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  // ---- 9. Hitting /console while signed-out fails closed.
  await page.context().clearCookies()
  await page.goto('/console')
  await page.waitForURL('**/login')
})
