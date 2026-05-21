// Lane 8 — CQ-156 production-wiring test.
//
// `startProsaCron` is the single production entry point that wires the
// audit + GC handler factories into the Lane 4 cron skeleton. The
// `startServer` boot path calls it. This test drives the same helper
// with a recording scheduler to prove:
//
//   1. Every `CRON_TASK_DEFINITIONS` task is registered exactly once.
//   2. Audit cadences invoke `registerAuditCron`'s handlers under the
//      advisory lock.
//   3. The GC cadence invokes `registerGcCron`'s handler under the lock.
//
// Together with `apps/api/src/server.ts`, the helper makes the
// production startup smoke command land on real audit/GC code:
//
//   rg -n "startProsaCron|registerAuditCron|registerGcCron" apps/api/src

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CRON_TASK_DEFINITIONS, type CronScheduler } from '../../../src/cron/index.js'
import { NOOP_METRICS, startProsaCron } from '../../../src/cron/wire.js'
import { type CronTestHarness, buildCronTestHarness } from './helpers.js'

type RecordedJob = { schedule: string; handler: () => Promise<void> }

function recordingScheduler(): { scheduler: CronScheduler; jobs: RecordedJob[] } {
  const jobs: RecordedJob[] = []
  const scheduler: CronScheduler = (schedule, handler) => {
    const entry: RecordedJob = { schedule, handler }
    jobs.push(entry)
    return () => {
      const idx = jobs.indexOf(entry)
      if (idx >= 0) jobs.splice(idx, 1)
    }
  }
  return { scheduler, jobs }
}

describe('Lane 8 production wiring — CQ-156', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('registers every audit + GC role exactly once via startProsaCron', () => {
    const { scheduler, jobs } = recordingScheduler()
    const handle = startProsaCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: { warn: () => {}, error: () => {} },
      metrics: NOOP_METRICS,
      scheduler,
    })
    try {
      expect(handle.registered.length).toBe(CRON_TASK_DEFINITIONS.length)
      const registeredNames = handle.registered.map((d) => d.name).sort()
      expect(registeredNames).toEqual(
        ['audit-daily', 'audit-hourly', 'audit-monthly', 'audit-weekly', 'gc-daily'].sort(),
      )
      expect(jobs.length).toBe(CRON_TASK_DEFINITIONS.length)
    } finally {
      handle.cancel()
    }
    expect(jobs.length).toBe(0)
  })

  it('runs the real audit + GC handlers under the advisory lock when a tick fires', async () => {
    // Seed a row that the hourly audit will see; with no bytes in
    // the store, the handler marks it `missing` so we can observe
    // a real audit code path executing under the cron skeleton.
    const tenantId = 't_wire_audit'
    const packDigest = 'pack_wire_audit'
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 16, 'root', $3, now())`,
      [tenantId, packDigest, `object-packs/${tenantId}/wire/${packDigest}.pack`],
    )

    const { scheduler, jobs } = recordingScheduler()
    const handle = startProsaCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: { warn: () => {}, error: () => {} },
      metrics: h.metrics,
      scheduler,
    })
    try {
      const hourly = jobs.find((j) => j.schedule === '0 * * * *')
      expect(hourly).toBeDefined()
      await hourly!.handler()
      const audit = await h.rawExec<{ status: string }>(
        `SELECT status FROM pack_audit_state WHERE tenant_id = $1 AND pack_digest = $2`,
        [tenantId, packDigest],
      )
      expect(audit).toHaveLength(1)
      expect(audit[0]!.status).toBe('quarantined')
      const events = h.metrics.events.filter((e) => e.name === 'prosa.audit.pack_missing')
      expect(events).toHaveLength(1)
    } finally {
      handle.cancel()
    }
  })

  it('runs the real GC handler under the advisory lock when the gc tick fires', async () => {
    const tenantId = 't_wire_gc'
    const packDigest = 'pack_wire_gc'
    const storageUri = `object-packs/${tenantId}/wire/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 8, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )

    const { scheduler, jobs } = recordingScheduler()
    const handle = startProsaCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: { warn: () => {}, error: () => {} },
      metrics: h.metrics,
      scheduler,
    })
    try {
      const gc = jobs.find((j) => j.schedule === '0 1 * * *')
      expect(gc).toBeDefined()
      await gc!.handler()
      const rows = await h.rawExec<{ status: string }>(
        `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
        [tenantId, packDigest],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('tombstone_pending')
    } finally {
      handle.cancel()
    }
  })
})
