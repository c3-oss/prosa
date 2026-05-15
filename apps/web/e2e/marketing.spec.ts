import { expect, test } from '@playwright/test'

test.describe('marketing surface (no API)', () => {
  test('renders the landing hero even when the API is unreachable', async ({ page }) => {
    // The AuthProvider attempts an auth.me probe at app boot. Force it to
    // fail at the network layer to simulate an unreachable API and confirm
    // the public landing route still renders end-to-end.
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
