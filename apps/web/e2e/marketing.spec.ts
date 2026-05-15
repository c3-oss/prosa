import { expect, test } from '@playwright/test'

test.describe('marketing surface (no API)', () => {
  test('renders the landing hero without contacting the API at all', async ({ page }) => {
    // CQ-002: marketing routes must NOT probe /trpc/* or /api/auth/* on first
    // render. We deliberately do NOT route.abort() here so that any silent
    // request still counts as a failure.
    const apiRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/trpc/') || request.url().includes('/api/auth/')) {
        apiRequests.push(`${request.method()} ${request.url()}`)
      }
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: /searchable console for agent session history/i })).toBeVisible()
    // Give any in-flight effects a tick to fire so the assertion is not flaky.
    await page.waitForTimeout(500)
    expect(apiRequests).toEqual([])
  })

  test('renders the landing hero when the API URL is unreachable', async ({ page }) => {
    await page.route('**/trpc/**', (route) => route.abort('failed'))
    await page.route('**/api/auth/**', (route) => route.abort('failed'))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /searchable console for agent session history/i })).toBeVisible()
  })

  test('the marketing header links to the login route', async ({ page }) => {
    await page.goto('/')
    await page
      .getByRole('navigation', { name: /Marketing navigation/i })
      .getByRole('link', { name: 'Login' })
      .click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()
  })
})
