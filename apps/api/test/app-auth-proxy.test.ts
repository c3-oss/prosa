import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { ProsaAuth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import type { DatabaseHandle, ProsaDatabase, RawExec } from '../src/db.js'

function createAuth(handler: ProsaAuth['handler']): ProsaAuth {
  return {
    handler,
    api: {},
  } as ProsaAuth
}

async function createApp(handler: ProsaAuth['handler']) {
  return buildApp({
    config: loadConfig({
      PROSA_RUNTIME_MODE: 'test',
      PROSA_API_URL: 'http://127.0.0.1:3000',
      PROSA_OBJECT_STORE_DRIVER: 'memory',
    } as NodeJS.ProcessEnv),
    auth: createAuth(handler),
    db: {} as ProsaDatabase,
    rawExec: vi.fn() as unknown as RawExec,
    transaction: vi.fn() as unknown as DatabaseHandle['transaction'],
    objectStore: new MemoryObjectStore(),
    loggerEnabled: false,
  })
}

describe('buildApp auth proxy', () => {
  it('forwards GET auth requests with repeated headers and response cookies', async () => {
    let forwarded: {
      body: string
      method: string
      url: string
      xTest: string | null
    } | null = null
    const handler = vi.fn(async (request: Request) => {
      forwarded = {
        body: await request.text(),
        method: request.method,
        url: request.url,
        xTest: request.headers.get('x-test'),
      }
      return new Response('ok', {
        status: 201,
        headers: {
          'set-cookie': 'sid=1; Path=/',
          'x-auth-result': 'forwarded',
        },
      })
    })
    const app = await createApp(handler)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: { 'x-test': ['a', 'b'] },
      })

      expect(response.statusCode).toBe(201)
      expect(response.body).toBe('ok')
      expect(response.headers['x-auth-result']).toBe('forwarded')
      expect(response.headers['set-cookie']).toBe('sid=1; Path=/')
      expect(handler).toHaveBeenCalledOnce()
      expect(forwarded).toEqual({
        body: '',
        method: 'GET',
        url: 'http://127.0.0.1:3000/api/auth/session',
        xTest: 'a,b',
      })
    } finally {
      await app.close()
    }
  })

  it('serializes POST JSON bodies and preserves explicit content type', async () => {
    let forwarded: {
      body: string
      contentType: string | null
      method: string
    } | null = null
    const handler = vi.fn(async (request: Request) => {
      forwarded = {
        body: await request.text(),
        contentType: request.headers.get('content-type'),
        method: request.method,
      }
      return new Response(null, { status: 204 })
    })
    const app = await createApp(handler)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'a@example.com' },
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe('')
      expect(handler).toHaveBeenCalledOnce()
      expect(forwarded).toEqual({
        body: '{"email":"a@example.com"}',
        contentType: 'application/json',
        method: 'POST',
      })
    } finally {
      await app.close()
    }
  })

  it('forwards string POST bodies without JSON serialization', async () => {
    let forwardedBody: string | null = null
    const handler = vi.fn(async (request: Request) => {
      forwardedBody = await request.text()
      return new Response('accepted')
    })
    const app = await createApp(handler)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/callback',
        headers: { 'content-type': 'text/plain' },
        payload: 'raw-auth-payload',
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('accepted')
      expect(handler).toHaveBeenCalledOnce()
      expect(forwardedBody).toBe('raw-auth-payload')
    } finally {
      await app.close()
    }
  })
})
