// Lane 8 — hourly audit throttle.
//
// The hourly handler must never visit more than
// MAX_HOURLY_AUDIT_OPS_PER_TENANT (=100) packs per tenant per tick.
// Seed 150 healthy packs, run the handler, and assert that at most 100
// header checks were recorded on `pack_audit_state.last_header_check_at`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_HOURLY_AUDIT_OPS_PER_TENANT, registerAuditCron } from '../../../src/cron/audit.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes, seedRemotePack } from './helpers.js'

describe('Lane 8 audit hourly — throttle', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('visits at most MAX_HOURLY_AUDIT_OPS_PER_TENANT packs in a single tenant tick', async () => {
    const tenantId = 't_throttle'
    const total = 150
    for (let i = 0; i < total; i += 1) {
      const digest = `pack_throttle_${i.toString(16).padStart(4, '0')}`
      const uri = await seedRemotePack(h, { tenantId, packDigest: digest, byteLength: 32 })
      await putPackBytes(h.store, uri, new Uint8Array(32))
    }

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['audit-hourly']()

    const audited = await h.rawExec<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pack_audit_state WHERE tenant_id = $1 AND last_header_check_at IS NOT NULL`,
      [tenantId],
    )
    const visited = Number(audited[0]?.n ?? '0')
    expect(visited).toBeGreaterThan(0)
    expect(visited).toBeLessThanOrEqual(MAX_HOURLY_AUDIT_OPS_PER_TENANT)
  })
})
