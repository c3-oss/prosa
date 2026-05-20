// Lane 4 gate: the cron skeleton wraps each registered task in
// `pg_try_advisory_lock` so only one worker per fleet runs a given
// audit/GC tick. Lane 8 will replace the no-op handler body with the
// real audit/GC implementation; this gate guarantees the lock contract
// is already in place.

import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CRON_TASK_DEFINITIONS,
  type CronScheduler,
  hashLockNameToInt64,
  startCron,
  withAdvisoryLock,
} from '../../src/cron/index.js'

type RegisteredJob = { schedule: string; handler: () => Promise<void>; cancel: () => void }

function recordingScheduler(): { scheduler: CronScheduler; jobs: RegisteredJob[] } {
  const jobs: RegisteredJob[] = []
  const scheduler: CronScheduler = (schedule, handler) => {
    const entry: RegisteredJob = { schedule, handler, cancel: () => {} }
    entry.cancel = () => {
      const idx = jobs.indexOf(entry)
      if (idx >= 0) jobs.splice(idx, 1)
    }
    jobs.push(entry)
    return entry.cancel
  }
  return { scheduler, jobs }
}

describe('cron advisory-lock skeleton', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
  })
  afterEach(async () => {
    await db.close()
  })

  const rawExec = <T>(sql: string, params: unknown[] = []): Promise<T[]> => db.query<T>(sql, params).then((r) => r.rows)

  it('registers each task definition exactly once', () => {
    const { scheduler, jobs } = recordingScheduler()
    const handle = startCron({ rawExec, scheduler })
    expect(handle.registered.length).toBe(CRON_TASK_DEFINITIONS.length)
    expect(jobs.length).toBe(CRON_TASK_DEFINITIONS.length)
    expect(jobs.map((j) => j.schedule).sort()).toEqual(CRON_TASK_DEFINITIONS.map((d) => d.schedule).sort())
    handle.cancel()
    expect(jobs.length).toBe(0)
  })

  it('exposes the canonical role list — 4 audit + 1 gc', () => {
    const roles = CRON_TASK_DEFINITIONS.map((d) => d.role)
    expect(roles.filter((r) => r === 'audit').length).toBe(4)
    expect(roles.filter((r) => r === 'gc').length).toBe(1)
  })

  it('acquires + releases the advisory lock when only one worker runs', async () => {
    const calls: string[] = []
    const handler = async () => {
      calls.push('ran')
    }
    const result = await withAdvisoryLock(rawExec, 'prosa-audit-hourly-test', handler)
    expect(result.acquired).toBe(true)
    expect(calls).toEqual(['ran'])

    // After release, a fresh call must succeed again.
    const again = await withAdvisoryLock(rawExec, 'prosa-audit-hourly-test', handler)
    expect(again.acquired).toBe(true)
    expect(calls).toEqual(['ran', 'ran'])
  })

  it('skips the handler when another worker already holds the lock', async () => {
    // PGlite advisory locks are per-instance, so a real cross-session
    // contention scenario cannot be simulated here. Instead, stub
    // `pg_try_advisory_lock` to return `false` on the first attempt
    // and `true` afterwards, and assert that the helper honours that
    // contract: handler skipped on contention, run + lock released on
    // a successful acquisition.
    let tryCalls = 0
    const unlockCalls: bigint[] = []
    const stubRawExec = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('pg_try_advisory_lock')) {
        tryCalls += 1
        return [{ pg_try_advisory_lock: tryCalls > 1 } as unknown as T]
      }
      if (sql.includes('pg_advisory_unlock')) {
        unlockCalls.push(params[0] as bigint)
        return [{ pg_advisory_unlock: true } as unknown as T]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }

    let ran = false
    const skipped = await withAdvisoryLock(stubRawExec, 'prosa-audit-hourly-contention', async () => {
      ran = true
    })
    expect(skipped.acquired).toBe(false)
    expect(ran).toBe(false)
    expect(unlockCalls.length).toBe(0)

    const acquired = await withAdvisoryLock(stubRawExec, 'prosa-audit-hourly-contention', async () => {
      ran = true
    })
    expect(acquired.acquired).toBe(true)
    expect(ran).toBe(true)
    expect(unlockCalls.length).toBe(1)
    expect(unlockCalls[0]).toBe(hashLockNameToInt64('prosa-audit-hourly-contention'))
  })

  it('releases the lock even when the handler throws', async () => {
    const unlockCalls: bigint[] = []
    const stubRawExec = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('pg_try_advisory_lock')) {
        return [{ pg_try_advisory_lock: true } as unknown as T]
      }
      if (sql.includes('pg_advisory_unlock')) {
        unlockCalls.push(params[0] as bigint)
        return [{ pg_advisory_unlock: true } as unknown as T]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(
      withAdvisoryLock(stubRawExec, 'prosa-gc-daily-boom', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(unlockCalls.length).toBe(1)
    expect(unlockCalls[0]).toBe(hashLockNameToInt64('prosa-gc-daily-boom'))
  })

  it('runs each scheduled tick through the advisory lock helper', async () => {
    const { scheduler, jobs } = recordingScheduler()
    const callMap = new Map<string, number>()
    const handlers: Record<string, () => Promise<void>> = {}
    for (const def of CRON_TASK_DEFINITIONS) {
      handlers[def.name] = async () => {
        callMap.set(def.name, (callMap.get(def.name) ?? 0) + 1)
      }
    }
    startCron({ rawExec, scheduler, handlers })

    // Fire each scheduled handler once. Each must acquire the lock and
    // increment its counter.
    for (const job of jobs) {
      await job.handler()
    }
    for (const def of CRON_TASK_DEFINITIONS) {
      expect(callMap.get(def.name)).toBe(1)
    }

    // Fire again — second tick must also succeed (lock was released).
    for (const job of jobs) {
      await job.handler()
    }
    for (const def of CRON_TASK_DEFINITIONS) {
      expect(callMap.get(def.name)).toBe(2)
    }
  })

  it('hashLockNameToInt64 is deterministic and uses distinct ids per name', () => {
    const a1 = hashLockNameToInt64('prosa-audit-hourly')
    const a2 = hashLockNameToInt64('prosa-audit-hourly')
    const b = hashLockNameToInt64('prosa-gc-daily')
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })
})
