// Invariant I5: a receipt signed by the v2 server can be verified
// against the published JWKS. This test exercises the local Ed25519
// signer; a KMS-backed implementation must satisfy the same contract
// before it can replace `createLocalReceiptSigner` in production.

import { describe, expect, it } from 'vitest'
import { createLocalReceiptSigner } from '../../src/v2/signing/local-signer.js'

const encoder = new TextEncoder()

describe('local receipt signer (invariant I5)', () => {
  it('round-trips sign + verify against the published key set', async () => {
    const signer = createLocalReceiptSigner()
    const payload = encoder.encode(JSON.stringify({ receipt_id: 'rcp_test', body: 'hello' }))

    const signature = await signer.signReceipt(payload)
    expect(signature.alg).toBe('EdDSA')
    expect(signature.keyId).toBe(signer.currentKeyId())
    expect(signature.sig.length).toBeGreaterThan(0)

    const jwks = signer.publishJwks()
    expect(jwks.keys.some((k) => k.kid === signature.keyId)).toBe(true)

    const ok = await signer.verifyReceipt(payload, signature)
    expect(ok).toBe(true)
  })

  it('rejects a tampered payload', async () => {
    const signer = createLocalReceiptSigner()
    const payload = encoder.encode('original')
    const signature = await signer.signReceipt(payload)

    const tampered = encoder.encode('tampered')
    const ok = await signer.verifyReceipt(tampered, signature)
    expect(ok).toBe(false)
  })

  it('rejects a signature signed by an unrelated signer', async () => {
    const signerA = createLocalReceiptSigner()
    const signerB = createLocalReceiptSigner()
    const payload = encoder.encode('cross-signer')
    const signatureFromB = await signerB.signReceipt(payload)

    // signerA does not know about signerB's key id, so verification
    // fails closed.
    const ok = await signerA.verifyReceipt(payload, signatureFromB)
    expect(ok).toBe(false)
  })

  it('keeps historical keys queryable after rotation', async () => {
    const signer = createLocalReceiptSigner()
    const payload = encoder.encode('rotation-test')

    const signedBeforeRotation = await signer.signReceipt(payload)
    const oldKid = signedBeforeRotation.keyId

    const newKid = signer.rotateCurrentKey()
    expect(newKid).not.toBe(oldKid)
    expect(signer.currentKeyId()).toBe(newKid)

    // The historical key must still appear in the published JWKS and
    // must still verify receipts it signed before the rotation.
    const jwks = signer.publishJwks()
    const kids = jwks.keys.map((k) => k.kid)
    expect(kids).toContain(oldKid)
    expect(kids).toContain(newKid)

    const okOld = await signer.verifyReceipt(payload, signedBeforeRotation)
    expect(okOld).toBe(true)

    // A receipt signed after rotation must verify against the new key id.
    const signedAfterRotation = await signer.signReceipt(payload)
    expect(signedAfterRotation.keyId).toBe(newKid)
    const okNew = await signer.verifyReceipt(payload, signedAfterRotation)
    expect(okNew).toBe(true)
  })

  it('rejects signatures with an unknown key id', async () => {
    const signer = createLocalReceiptSigner()
    const payload = encoder.encode('unknown-kid')
    const sig = await signer.signReceipt(payload)
    const ok = await signer.verifyReceipt(payload, { ...sig, keyId: 'kid-that-was-never-issued' })
    expect(ok).toBe(false)
  })

  it('rejects signatures with a non-EdDSA alg', async () => {
    const signer = createLocalReceiptSigner()
    const payload = encoder.encode('wrong-alg')
    const sig = await signer.signReceipt(payload)
    const ok = await signer.verifyReceipt(payload, { ...sig, alg: 'ES256' as 'EdDSA' })
    expect(ok).toBe(false)
  })
})
