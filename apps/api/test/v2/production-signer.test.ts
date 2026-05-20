// CQ-120: production-mode boot must fail closed if no durable/KMS-backed
// signer is supplied. Tests/development may still use the in-process
// local signer.

import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { MissingV2SignerError, registerV2Routes } from '../../src/v2/index.js'
import { createLocalReceiptSigner } from '../../src/v2/signing/local-signer.js'

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
      runtimeMode: 'production',
      signer,
    })
    expect(handle.signer).toBe(signer)
  })

  it('falls back to the local signer in development mode', () => {
    const app = Fastify({ logger: false })
    const handle = registerV2Routes(app, {
      auth: stubAuth(),
      rawExec: stubRawExec,
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
