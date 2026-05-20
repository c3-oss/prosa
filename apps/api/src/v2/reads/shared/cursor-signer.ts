// Lane 6 / CQ-142 follow-up — cursor integrity.
//
// The snapshot embedded in a paginated cursor names a set of
// `(store_id, receipt_id)` pairs the server is willing to read on
// the caller's behalf. Without integrity, a malicious client can
// forge a cursor that names a superseded receipt and the server
// would dutifully read rows out from under the current authority.
// `CursorSigner` HMACs the cursor payload so any tampering — to
// the sort tuple, to the snapshot, to any future field — produces
// a verification failure and the route layer responds 400 /
// `INVALID_CURSOR`.
//
// Token format: `base64url(payloadJson).base64url(hmac)`. The HMAC
// covers the encoded payload bytes so verification is constant-time
// over `Buffer.from(payload, 'base64url')` and rejects truncation
// without parsing JSON.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALGO = 'sha256'
const SEPARATOR = '.'

export interface CursorSigner {
  /**
   * Encode + sign a cursor payload. The returned token round-trips
   * through `verifyCursorToken`.
   */
  sign(payload: unknown): string
  /**
   * Verify + decode a cursor token. Throws on missing separator,
   * bad base64url, bad JSON, or HMAC mismatch.
   */
  verify(token: string): unknown
}

export class CursorIntegrityError extends Error {
  override name = 'CursorIntegrityError'
}

/**
 * Create a cursor signer backed by the provided HMAC key. The key
 * is keep-in-memory only; production deployments inject the key
 * from `PROSA_CURSOR_HMAC_SECRET` (32-byte minimum). Dev / test
 * boots fall back to `createInProcessCursorSigner` which
 * synthesizes a 32-byte random key on first use.
 */
export function createCursorSigner(key: Buffer): CursorSigner {
  if (key.byteLength < 32) {
    throw new Error('createCursorSigner: HMAC key must be at least 32 bytes')
  }
  const frozenKey = Buffer.from(key)

  function sign(payload: unknown): string {
    const json = JSON.stringify(payload)
    const payloadB64 = Buffer.from(json, 'utf8').toString('base64url')
    const mac = createHmac(ALGO, frozenKey).update(payloadB64).digest()
    const macB64 = mac.toString('base64url')
    return `${payloadB64}${SEPARATOR}${macB64}`
  }

  function verify(token: string): unknown {
    if (typeof token !== 'string' || token.length === 0) {
      throw new CursorIntegrityError('cursor token is empty')
    }
    const sep = token.indexOf(SEPARATOR)
    if (sep <= 0 || sep === token.length - 1) {
      throw new CursorIntegrityError('cursor token missing separator')
    }
    const payloadB64 = token.slice(0, sep)
    const macB64 = token.slice(sep + 1)

    let providedMac: Buffer
    try {
      providedMac = Buffer.from(macB64, 'base64url')
    } catch {
      throw new CursorIntegrityError('cursor mac is not valid base64url')
    }
    if (providedMac.byteLength !== 32) {
      throw new CursorIntegrityError('cursor mac has wrong length')
    }

    const expectedMac = createHmac(ALGO, frozenKey).update(payloadB64).digest()
    if (!timingSafeEqual(providedMac, expectedMac)) {
      throw new CursorIntegrityError('cursor mac does not verify')
    }

    let payloadJson: string
    try {
      payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8')
    } catch {
      throw new CursorIntegrityError('cursor payload is not valid base64url')
    }
    try {
      return JSON.parse(payloadJson)
    } catch {
      throw new CursorIntegrityError('cursor payload is not valid JSON')
    }
  }

  return { sign, verify }
}

/**
 * Default signer for development / test boots: synthesizes a fresh
 * 32-byte random key per process. Single-worker deployments may use
 * this; multi-worker production must configure a shared
 * `PROSA_CURSOR_HMAC_SECRET` so cursors validate across workers.
 */
export function createInProcessCursorSigner(): CursorSigner {
  return createCursorSigner(randomBytes(32))
}
