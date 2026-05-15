import { describe, expect, it } from 'vitest'
import { buildTestApp } from './helpers/test-app.js'

describe('tRPC /trpc', () => {
  it('serves health.ping as a query', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: '/trpc/health.ping' })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { result: { data: { ok: boolean; version: string } } }
      expect(body.result.data.ok).toBe(true)
      expect(typeof body.result.data.version).toBe('string')
    } finally {
      await t.close()
    }
  })

  it('returns echoed input from system.echo', async () => {
    const t = await buildTestApp()
    try {
      const input = encodeURIComponent(JSON.stringify({ message: 'hello' }))
      const response = await t.app.inject({
        method: 'GET',
        url: `/trpc/system.echo?input=${input}`,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { result: { data: { message: string } } }
      expect(body.result.data.message).toBe('hello')
    } finally {
      await t.close()
    }
  })

  it('rejects auth.me without a session', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: '/trpc/auth.me' })
      expect(response.statusCode).toBe(401)
    } finally {
      await t.close()
    }
  })
})
