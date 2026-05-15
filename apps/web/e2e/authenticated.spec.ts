import { expect, test } from '@playwright/test'

/**
 * CQ-001: prove the authenticated browser flow end-to-end against a real
 * API. The Playwright config boots a PGlite-backed apps/api on port 3001
 * with PROSA_WEB_ORIGIN pointing at the Vite dev server.
 */

const uniqueSlug = () => `e2e-${Math.random().toString(36).slice(2, 10)}`

test('signup → console → sessions → analytics → logout', async ({ page }) => {
  test.setTimeout(60_000)

  const slug = uniqueSlug()
  const email = `${slug}@e2e.prosa.dev`

  // Signup. The label-and-description layout means `getByLabel(text)`
  // resolves on substring; select by autocomplete attributes for stability.
  await page.goto('/signup')
  await page.locator('input[autocomplete="name"]').fill('E2E User')
  await page.locator('input[autocomplete="email"]').fill(email)
  await page.locator('input[autocomplete="new-password"]').fill('correct-horse-battery')
  await page.locator('input[type="text"]:not([autocomplete]), input:not([type]):not([autocomplete])').first().fill(slug)
  await page.locator('input[type="text"]:not([autocomplete]), input:not([type]):not([autocomplete])').nth(1).fill(slug)
  await page.getByRole('button', { name: 'Create account' }).click()

  // Lands on the console dashboard once Better Auth's session cookie is set.
  await page.waitForURL('**/console')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  // Empty tenant guidance is visible because we have no promoted data yet.
  await expect(page.getByText('No promoted sessions yet.').first()).toBeVisible()

  // Sessions route loads (empty data) without a server error.
  await page.getByRole('link', { name: 'Sessions' }).click()
  await page.waitForURL('**/console/sessions')
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible()

  // Analytics route loads and shows the empty state for the sessions report.
  await page.getByRole('link', { name: 'Analytics' }).click()
  await page.waitForURL('**/console/analytics')
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()

  // Search route loads and shows the "enter a query" empty state.
  await page.getByRole('link', { name: 'Search' }).click()
  await page.waitForURL('**/console/search')
  await expect(page.getByText(/enter a query to start/i)).toBeVisible()

  // Tool calls route loads and shows the empty state.
  await page.getByRole('link', { name: 'Tool calls' }).click()
  await page.waitForURL('**/console/tool-calls')
  await expect(page.getByRole('heading', { name: 'Tool calls' })).toBeVisible()

  // Sign out.
  await page.getByRole('button', { name: /sign out/i }).click()
  await page.waitForURL('**/login')
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()

  // After logout, hitting /console redirects to /login (fail-closed).
  await page.goto('/console')
  await page.waitForURL('**/login')
})
