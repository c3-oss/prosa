import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

describe('tRPC /trpc', () => {
  it('serves health.ping as a query', async () => {
    const config = loadConfig({ PROSA_OBJECT_STORE_DRIVER: 'memory' } as NodeJS.ProcessEnv)
    const app = await buildApp({ config, loggerEnabled: false })
    try {
      const response = await app.inject({ method: 'GET', url: '/trpc/health.ping' })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { result: { data: { ok: boolean; version: string } } }
      expect(body.result.data.ok).toBe(true)
      expect(typeof body.result.data.version).toBe('string')
    } finally {
      await app.close()
    }
  })

  it('returns echoed input from system.echo', async () => {
    const config = loadConfig({ PROSA_OBJECT_STORE_DRIVER: 'memory' } as NodeJS.ProcessEnv)
    const app = await buildApp({ config, loggerEnabled: false })
    try {
      const input = encodeURIComponent(JSON.stringify({ message: 'hello' }))
      const response = await app.inject({
        method: 'GET',
        url: `/trpc/system.echo?input=${input}`,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { result: { data: { message: string } } }
      expect(body.result.data.message).toBe('hello')
    } finally {
      await app.close()
    }
  })
})
