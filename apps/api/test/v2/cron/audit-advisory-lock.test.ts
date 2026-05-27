// Lane 8 — advisory-lock contention.
//
// Two simulated workers schedule the same hourly tick. Only the one
// that acquires the Postgres advisory lock runs the handler body; the
// loser observes `acquired: false` and the handler is never invoked
// (no extra `pack_audit_state` updates).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withAdvisoryLock } from '../../../src/cron/advisory-lock.js'
import { registerAuditCron } from '../../../src/cron/audit.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes, seedRemotePack } from './helpers.js'

describe('Lane 8 audit hourly — advisory lock', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('runs the handler exactly once when two workers race on the same tick', async () => {
    const tenantId = 't_lock'
    const packDigest = 'pack_lock_a'
    const uri = await seedRemotePack(h, { tenantId, packDigest, byteLength: 8 })
    await putPackBytes(h.store, uri, new Uint8Array(8))

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })

    // Stubbed advisory-lock rawExec: deterministic contention. First
    // caller wins, second loses.
    let tryCalls = 0
    const stub = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('pg_try_advisory_lock')) {
        tryCalls += 1
        return [{ pg_try_advisory_lock: tryCalls === 1 } as unknown as T]
      }
      if (sql.includes('pg_advisory_unlock')) {
        return [{ pg_advisory_unlock: true } as unknown as T]
      }
      return []
    }

    const first = await withAdvisoryLock(stub, 'prosa-audit-hourly', handlers['audit-hourly'])
    const second = await withAdvisoryLock(stub, 'prosa-audit-hourly', handlers['audit-hourly'])

    expect(first.acquired).toBe(true)
    expect(second.acquired).toBe(false)

    const audit = await h.rawExec<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pack_audit_state WHERE tenant_id = $1`,
      [tenantId],
    )
    expect(Number(audit[0]?.n ?? '0')).toBe(1)
  })
})
