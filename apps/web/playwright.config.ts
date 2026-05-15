import { defineConfig, devices } from '@playwright/test'

const WEB_PORT = Number.parseInt(process.env.PROSA_WEB_E2E_PORT ?? '5174', 10)
const API_PORT = Number.parseInt(process.env.PROSA_API_PORT ?? '3030', 10)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx ./e2e/serve-api.ts',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PROSA_API_PORT: String(API_PORT),
        PROSA_WEB_E2E_PORT: String(WEB_PORT),
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort --mode development`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_PROSA_API_URL: `http://127.0.0.1:${API_PORT}`,
        VITE_PROSA_APP_ENV: 'development',
      },
    },
  ],
})
