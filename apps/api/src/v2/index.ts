// v2 plugin entry. Wires the v2 route surface onto a Fastify instance:
// JWKS endpoint plus 501 promotion route definitions. The plugin
// intentionally does not own auth or DB lifecycle — those are passed in
// from `buildApp` and reused so v1 and v2 share the same Better Auth
// session, tenant resolution, and database handle.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance } from 'fastify'
import type { ProsaAuth } from '../auth.js'
import type { RuntimeMode } from '../config.js'
import type { DatabaseHandle, RawExec } from '../db.js'
import { registerReceiptKeysRoute } from './keys.js'
import { registerPromotionRoutes } from './promotion.js'
import { type ReceiptSigner, createLocalReceiptSigner } from './signing/local-signer.js'

export class MissingV2SignerError extends Error {
  override name = 'MissingV2SignerError'
  constructor() {
    super(
      'v2 receipt signer is required in production. Configure a durable/KMS-backed signer; ' +
        'createLocalReceiptSigner is for development/test only and keeps the private key in memory.',
    )
  }
}

export type V2PluginDeps = {
  auth: ProsaAuth
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  /**
   * Runtime mode from `loadConfig`. In `production`, `signer` is
   * required — the plugin refuses to fall back to the in-process local
   * signer because a process restart would invalidate every receipt
   * the prior process signed (CQ-120).
   */
  runtimeMode: RuntimeMode
  /**
   * Receipt signer. Production-mode boot MUST pass a durable/KMS-backed
   * implementation; `development` and `test` boots may pass undefined
   * and the plugin will create an in-process Ed25519 signer.
   */
  signer?: ReceiptSigner
}

export type V2PluginHandle = {
  signer: ReceiptSigner
}

export function registerV2Routes(app: FastifyInstance, deps: V2PluginDeps): V2PluginHandle {
  const signer = resolveSigner(deps)
  registerReceiptKeysRoute(app, { signer })
  registerPromotionRoutes(app, {
    auth: deps.auth,
    rawExec: deps.rawExec,
    transaction: deps.transaction,
    objectStore: deps.objectStore,
    signer,
  })
  return { signer }
}

function resolveSigner(deps: V2PluginDeps): ReceiptSigner {
  if (deps.signer) return deps.signer
  if (deps.runtimeMode === 'production') throw new MissingV2SignerError()
  return createLocalReceiptSigner()
}

export { V2_RECEIPT_KEYS_PATH } from './keys.js'
export { V2_PROMOTION_ROUTES } from './promotion.js'
export { createLocalReceiptSigner } from './signing/local-signer.js'
export type { JwkOkp, JwkSet, ReceiptSignature, ReceiptSigner } from './signing/local-signer.js'
