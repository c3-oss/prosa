import { describe, expect, it } from 'vitest'
import { buildTestApp } from './helpers/test-app.js'

describe('GET /health', () => {
  it('returns ok with package version', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { ok: boolean; version: string }
      expect(body.ok).toBe(true)
      expect(typeof body.version).toBe('string')
      expect(body.version.length).toBeGreaterThan(0)
    } finally {
      await t.close()
    }
  })
})
