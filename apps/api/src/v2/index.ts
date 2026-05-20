// v2 plugin entry. Wires the v2 route surface onto a Fastify instance:
// JWKS endpoint plus 501 promotion route definitions. The plugin
// intentionally does not own auth or DB lifecycle — those are passed in
// from `buildApp` and reused so v1 and v2 share the same Better Auth
// session, tenant resolution, and database handle.

import type { FastifyInstance } from 'fastify'
import type { ProsaAuth } from '../auth.js'
import type { RawExec } from '../db.js'
import { registerReceiptKeysRoute } from './keys.js'
import { registerPromotionRoutes } from './promotion.js'
import { type ReceiptSigner, createLocalReceiptSigner } from './signing/local-signer.js'

export type V2PluginDeps = {
  auth: ProsaAuth
  rawExec: RawExec
  /**
   * Optional pre-built signer. If omitted, the plugin creates a local
   * Ed25519 signer with one current key. Production-mode boot should
   * eventually pass a KMS-backed implementation; until then, the local
   * signer satisfies invariant I5 in tests.
   */
  signer?: ReceiptSigner
}

export type V2PluginHandle = {
  signer: ReceiptSigner
}

export function registerV2Routes(app: FastifyInstance, deps: V2PluginDeps): V2PluginHandle {
  const signer = deps.signer ?? createLocalReceiptSigner()
  registerReceiptKeysRoute(app, { signer })
  registerPromotionRoutes(app, { auth: deps.auth, rawExec: deps.rawExec })
  return { signer }
}

export { V2_RECEIPT_KEYS_PATH } from './keys.js'
export { V2_PROMOTION_ROUTES } from './promotion.js'
export { createLocalReceiptSigner } from './signing/local-signer.js'
export type { JwkOkp, JwkSet, ReceiptSignature, ReceiptSigner } from './signing/local-signer.js'
