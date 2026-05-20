// JWKS endpoint at /v2/.well-known/receipt-keys.json. Publishes the
// signer's current plus historical public keys so a client can verify
// any receipt the server has ever signed against an authoritative key
// set. Retention is infinite — the JWKS never drops a key after rotation.

import type { FastifyInstance } from 'fastify'
import type { ReceiptSigner } from './signing/local-signer.js'

export type RegisterReceiptKeysOpts = {
  signer: ReceiptSigner
}

export const V2_RECEIPT_KEYS_PATH = '/v2/.well-known/receipt-keys.json'

export function registerReceiptKeysRoute(app: FastifyInstance, opts: RegisterReceiptKeysOpts): void {
  app.get(V2_RECEIPT_KEYS_PATH, async (_req, reply) => {
    reply.header('content-type', 'application/jwk-set+json')
    return opts.signer.publishJwks()
  })
}
