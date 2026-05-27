// Lane 6 / CQ-142 follow-up — cursor integrity acceptance.
//
// The receipt-snapshot embedded in a paginated cursor names the
// `(store_id, receipt_id)` pairs the server is willing to read.
// Without HMAC integrity a malicious client could forge a cursor
// that names a superseded receipt. The handlers wrap every cursor
// through `CursorSigner.sign` / `verify`, so:
//
//   1. A legitimate server-issued cursor round-trips.
//   2. A cursor signed by a different signer (different HMAC key)
//      is rejected with `InvalidCursorError`.
//   3. Editing any byte of a legitimate cursor produces
//      `InvalidCursorError`.
//   4. A hand-rolled "valid base64, valid JSON" payload with no
//      HMAC suffix is rejected.
//   5. A cursor with a *forged* snapshot — one that names a
//      receipt the server never issued — is rejected before the
//      handler ever reads from the database.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../../../src/v2/reads/sessions/list.js'
import { InvalidCursorError } from '../../../src/v2/reads/shared/authority-snapshot.js'
import {
  CursorIntegrityError,
  createCursorSigner,
  createInProcessCursorSigner,
} from '../../../src/v2/reads/shared/cursor-signer.js'

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

const tenantId = 't_a'
const storeId = 's_a'

describe('Lane 6 cursor integrity — CursorSigner contract', () => {
  it('round-trips a payload through sign + verify', () => {
    const signer = createInProcessCursorSigner()
    const payload = { startedAt: '2026-05-19T10:00:00Z', id: 'ses_a', snapshot: [{ s: 'store_a', r: 'rcp_a' }] }
    const token = signer.sign(payload)
    expect(signer.verify(token)).toEqual(payload)
  })

  it('rejects a token signed by a different signer', () => {
    const alice = createInProcessCursorSigner()
    const bob = createInProcessCursorSigner()
    const token = alice.sign({ x: 1 })
    expect(() => bob.verify(token)).toThrow(CursorIntegrityError)
  })

  it('rejects a token whose payload portion has been edited', () => {
    const signer = createInProcessCursorSigner()
    const token = signer.sign({ startedAt: 'a', id: 'b', snapshot: [{ s: 's', r: 'r' }] })
    const [payloadB64, macB64] = token.split('.', 2)
    if (!payloadB64 || !macB64) throw new Error('expected token shape')
    // Flip the first character of the payload section.
    const tampered = `${payloadB64.slice(1)}A${SEPARATOR}${macB64}`
    expect(() => signer.verify(tampered)).toThrow(CursorIntegrityError)
  })

  it('rejects a token with no mac portion at all (hand-rolled base64-only)', () => {
    const signer = createInProcessCursorSigner()
    const handRolled = Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64url')
    expect(() => signer.verify(handRolled)).toThrow(CursorIntegrityError)
  })

  it('refuses to construct a signer with a short HMAC key', () => {
    expect(() => createCursorSigner(Buffer.alloc(16))).toThrow(/at least 32 bytes/)
  })
})

const SEPARATOR = '.'

describe('Lane 6 cursor integrity — forged snapshot is rejected at the handler boundary', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await db.query(
      `INSERT INTO remote_authority_v2
         (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())`,
      [tenantId, storeId, 'rcp_current', 'aa'.repeat(16)],
    )
  })
  afterEach(async () => {
    await db.close()
  })

  it('rejects a hand-forged cursor whose snapshot names a superseded receipt', async () => {
    // No legitimate page-1 fetch happened — the cursor below is
    // hand-rolled to name a receipt the server never issued. The
    // handler must not even reach the projection table.
    const signer = createInProcessCursorSigner()
    const otherSigner = createInProcessCursorSigner()
    const forgedPayload = {
      startedAt: '2026-05-19T10:00:00Z',
      id: 'ses_attacker_choice',
      snapshot: [{ s: storeId, r: 'rcp_superseded_attacker_pick' }],
    }
    // Sign with a *different* signer to simulate the attacker
    // forging without the server's key.
    const forgedToken = otherSigner.sign(forgedPayload)

    await expect(
      listSessions({ rawExec: makeRawExec(db), cursorSigner: signer }, tenantId, {
        limit: 10,
        cursor: forgedToken,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })

  it('rejects a cursor that round-trips through the wrong signer (cross-process tamper)', async () => {
    const serverSigner = createInProcessCursorSigner()
    const otherSigner = createInProcessCursorSigner()
    // Issue a legitimate page-1 cursor from `otherSigner`, then
    // present it to the server signed with `serverSigner` — the
    // server must reject.
    const otherCursor = otherSigner.sign({
      startedAt: '2026-05-19T10:00:00Z',
      id: 'ses_x',
      snapshot: [{ s: storeId, r: 'rcp_current' }],
    })
    await expect(
      listSessions({ rawExec: makeRawExec(db), cursorSigner: serverSigner }, tenantId, {
        limit: 10,
        cursor: otherCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})
