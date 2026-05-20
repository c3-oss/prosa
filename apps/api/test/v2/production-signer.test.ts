// CQ-120: production-mode boot must fail closed if no durable/KMS-backed
// signer is supplied. Tests/development may still use the in-process
// local signer.
// CQ-146: production-mode boot must also refuse to fall back to a
// per-process random cursor HMAC signer.

import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { MissingCursorSecretError, MissingV2SignerError, registerV2Routes } from '../../src/v2/index.js'
import { createCursorSigner, createInProcessCursorSigner } from '../../src/v2/reads/shared/cursor-signer.js'
import { createLocalReceiptSigner } from '../../src/v2/signing/local-signer.js'

const PROD_CURSOR_SECRET = 'a-real-cursor-hmac-secret-of-32+-bytes-xyz'

function stubAuth(): import('../../src/auth.js').ProsaAuth {
  return {
    api: { getSession: async () => null },
    handler: async () => new Response('', { status: 200 }),
  } as unknown as import('../../src/auth.js').ProsaAuth
}

async function stubRawExec<T>(): Promise<T[]> {
  return []
}

describe('v2 plugin production-mode signer policy', () => {
  it('refuses to boot in production when no signer is configured', () => {
    const app = Fastify({ logger: false })
    expect(() =>
      registerV2Routes(app, {
        auth: stubAuth(),
        rawExec: stubRawExec,
        objectStore: new MemoryObjectStore(),
        transaction: async (fn) => fn(stubRawExec),
        runtimeMode: 'production',
        // signer intentionally omitted
      }),
    ).toThrow(MissingV2SignerError)
  })

  it('accepts an explicit signer in production', () => {
    const app = Fastify({ logger: false })
    const signer = createLocalReceiptSigner({ kidPrefix: 'prod-injected' })
    const handle = registerV2Routes(app, {
      auth: stubAuth(),
      rawExec: stubRawExec,
      objectStore: new MemoryObjectStore(),
      transaction: async (fn) => fn(stubRawExec),
      runtimeMode: 'production',
      signer,
      cursorHmacSecret: PROD_CURSOR_SECRET,
    })
    expect(handle.signer).toBe(signer)
  })

  it('CQ-146: refuses to boot in production when no cursor HMAC secret is configured', () => {
    const app = Fastify({ logger: false })
    const signer = createLocalReceiptSigner({ kidPrefix: 'prod-injected' })
    expect(() =>
      registerV2Routes(app, {
        auth: stubAuth(),
        rawExec: stubRawExec,
        objectStore: new MemoryObjectStore(),
        transaction: async (fn) => fn(stubRawExec),
        runtimeMode: 'production',
        signer,
        // cursorHmacSecret intentionally omitted
      }),
    ).toThrow(MissingCursorSecretError)
  })

  it('CQ-146: two plugin instances sharing the same secret accept each others cursors', () => {
    const a = createCursorSigner(Buffer.from(PROD_CURSOR_SECRET, 'utf8'))
    const b = createCursorSigner(Buffer.from(PROD_CURSOR_SECRET, 'utf8'))
    const payload = { startedAt: 'x', id: 'y', snapshot: [{ s: 's', r: 'r' }] }
    const token = a.sign(payload)
    expect(b.verify(token)).toEqual(payload)
  })

  it('CQ-146: a different secret rejects another instance’s cursor', () => {
    const a = createCursorSigner(Buffer.from(PROD_CURSOR_SECRET, 'utf8'))
    const otherSecret = `${PROD_CURSOR_SECRET}-different`
    const b = createCursorSigner(Buffer.from(otherSecret, 'utf8'))
    expect(() => b.verify(a.sign({ startedAt: 'x', id: 'y', snapshot: [] }))).toThrow()
  })

  it('CQ-146: development boot uses a per-process random cursor signer when no secret is set', () => {
    const app = Fastify({ logger: false })
    const handle = registerV2Routes(app, {
      auth: stubAuth(),
      rawExec: stubRawExec,
      objectStore: new MemoryObjectStore(),
      transaction: async (fn) => fn(stubRawExec),
      runtimeMode: 'development',
    })
    expect(handle.reads.cursorSigner).toBeDefined()
    // Smoke: the resolved signer behaves like an in-process signer
    // (signs + verifies its own payloads).
    const token = handle.reads.cursorSigner.sign({ x: 1 })
    expect(handle.reads.cursorSigner.verify(token)).toEqual({ x: 1 })
    // A foreign signer must not verify the development signer's token.
    const foreign = createInProcessCursorSigner()
    expect(() => foreign.verify(token)).toThrow()
  })

  it('falls back to the local signer in development mode', () => {
    const app = Fastify({ logger: false })
    const handle = registerV2Routes(app, {
      auth: stubAuth(),
      rawExec: stubRawExec,
      objectStore: new MemoryObjectStore(),
      transaction: async (fn) => fn(stubRawExec),
      runtimeMode: 'development',
    })
    expect(handle.signer).toBeDefined()
    // The fallback signer is wired so JWKS still publishes at least one key.
    expect(handle.signer.publishJwks().keys.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to the local signer in test mode', () => {
    const app = Fastify({ logger: false })
    const handle = registerV2Routes(app, {
      auth: stubAuth(),
      rawExec: stubRawExec,
      objectStore: new MemoryObjectStore(),
      transaction: async (fn) => fn(stubRawExec),
      runtimeMode: 'test',
    })
    expect(handle.signer).toBeDefined()
    expect(handle.signer.publishJwks().keys.length).toBeGreaterThanOrEqual(1)
  })

  it('MissingV2SignerError carries a guidance message', () => {
    const err = new MissingV2SignerError()
    expect(err.name).toBe('MissingV2SignerError')
    expect(err.message).toMatch(/production/)
    expect(err.message).toMatch(/createLocalReceiptSigner/)
  })
})
