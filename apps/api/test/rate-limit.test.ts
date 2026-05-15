import { describe, expect, it } from 'vitest'
import { resetRateLimitBucketsForTests } from '../src/trpc/init.js'
import { buildTestApp } from './helpers/test-app.js'

async function trpcMutation(
  app: Awaited<ReturnType<typeof buildTestApp>>['app'],
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: input as never,
  })
}

describe('auth rate limits', () => {
  it('limits repeated public signup attempts by client IP', async () => {
    resetRateLimitBucketsForTests()
    const t = await buildTestApp()
    try {
      const headers = { 'x-forwarded-for': '203.0.113.10' }
      let lastStatus = 0
      for (let i = 0; i < 41; i += 1) {
        const response = await trpcMutation(
          t.app,
          'auth.signupWithTenant',
          {
            email: 'rate-signup@example.com',
            password: 'correct-horse-battery',
            name: 'Rate Limited',
            tenantName: 'Rate Limited',
            tenantSlug: 'rate-limited',
          },
          headers,
        )
        lastStatus = response.statusCode
      }
      expect(lastStatus).toBe(429)
    } finally {
      await t.close()
      resetRateLimitBucketsForTests()
    }
  })

  it('limits device token polling by client IP and device code', async () => {
    resetRateLimitBucketsForTests()
    const t = await buildTestApp()
    try {
      const headers = { 'x-forwarded-for': '203.0.113.11' }
      let lastStatus = 0
      for (let i = 0; i < 11; i += 1) {
        const response = await trpcMutation(
          t.app,
          'auth.deviceToken',
          { deviceCode: 'missing-device-code', clientId: 'prosa-cli' },
          headers,
        )
        lastStatus = response.statusCode
      }
      expect(lastStatus).toBe(429)
    } finally {
      await t.close()
      resetRateLimitBucketsForTests()
    }
  })
})
