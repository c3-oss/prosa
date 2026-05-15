import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

describe('GET /health', () => {
  it('returns ok with package version', async () => {
    const config = loadConfig({ PROSA_OBJECT_STORE_DRIVER: 'memory' } as NodeJS.ProcessEnv)
    const app = await buildApp({ config, loggerEnabled: false })
    try {
      const response = await app.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { ok: boolean; version: string }
      expect(body.ok).toBe(true)
      expect(typeof body.version).toBe('string')
      expect(body.version.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })
})
