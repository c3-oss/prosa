// Local Ed25519 signer used by tests and by production-mode boot when no
// KMS configuration is present. Production deployments must replace this
// with a KMS-backed signer (Lane 4 Task 4). The local signer keeps the
// private key in memory for the lifetime of the process; nothing is
// persisted to disk.
//
// JWKS publishes one current key plus any number of historical public
// keys. Historical keys are kept so receipts signed before a rotation
// remain verifiable; this matches invariant I5 (signature roundtrip
// against a published key set).

import {
  type KeyObject,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto'

export type JwkOkp = {
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
  use: 'sig'
  /** JWA algorithm name for Ed25519 signatures (RFC 8037). */
  alg: 'EdDSA'
  kid: string
}

export type JwkSet = {
  keys: JwkOkp[]
}

/**
 * Wire-shape signature emitted by the v2 server. Matches
 * `PromotionReceiptV2Signature` from `@c3-oss/prosa-types-v2`:
 * `alg: 'Ed25519'` is the curve name used by the receipt wire schema,
 * which is intentionally distinct from the JWA name `EdDSA` used in
 * the JWKS (see RFC 8037 §3.1).
 */
export type ReceiptSignature = {
  alg: 'Ed25519'
  keyId: string
  /** base64url-encoded raw signature bytes. */
  sig: string
}

export type ReceiptSigner = {
  /** Sign `payload` and return the signature plus the signing key id. */
  signReceipt(payload: Uint8Array): Promise<ReceiptSignature>
  /** Verify a signature against the published key set. */
  verifyReceipt(payload: Uint8Array, sig: ReceiptSignature): Promise<boolean>
  /** Current + historical public keys as a JWKS document. */
  publishJwks(): JwkSet
  /** Mark the current key as historical and rotate to a new key. */
  rotateCurrentKey(): string
  /** The key id used by the next `signReceipt` call. */
  currentKeyId(): string
}

type KeyEntry = {
  kid: string
  privateKey: KeyObject
  publicJwk: JwkOkp
}

function makeKeyEntry(kid: string): KeyEntry {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: 'OKP'; crv: 'Ed25519'; x: string }
  return {
    kid,
    privateKey,
    publicJwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: jwk.x,
      use: 'sig',
      alg: 'EdDSA',
      kid,
    },
  }
}

function publicJwkToKeyObject(jwk: JwkOkp): KeyObject {
  return createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as unknown as Record<string, string>,
    format: 'jwk',
  })
}

let kidCounter = 0
function nextKid(prefix: string): string {
  kidCounter += 1
  const ts = Date.now().toString(36)
  return `${prefix}-${ts}-${kidCounter.toString(36)}`
}

export function createLocalReceiptSigner(opts: { kidPrefix?: string } = {}): ReceiptSigner {
  const prefix = opts.kidPrefix ?? 'prosa-receipt-local'
  let current = makeKeyEntry(nextKid(prefix))
  const historical: KeyEntry[] = []

  const findByKid = (kid: string): KeyEntry | null => {
    if (current.kid === kid) return current
    for (const h of historical) if (h.kid === kid) return h
    return null
  }

  return {
    async signReceipt(payload) {
      const signature = nodeSign(null, payload, current.privateKey)
      return {
        alg: 'Ed25519',
        keyId: current.kid,
        sig: Buffer.from(signature).toString('base64url'),
      }
    },
    async verifyReceipt(payload, sig) {
      if (sig.alg !== 'Ed25519') return false
      const entry = findByKid(sig.keyId)
      if (!entry) return false
      const signature = Buffer.from(sig.sig, 'base64url')
      return nodeVerify(null, payload, publicJwkToKeyObject(entry.publicJwk), signature)
    },
    publishJwks() {
      return { keys: [current.publicJwk, ...historical.map((h) => h.publicJwk)] }
    },
    rotateCurrentKey() {
      historical.push(current)
      current = makeKeyEntry(nextKid(prefix))
      return current.kid
    },
    currentKeyId() {
      return current.kid
    },
  }
}
