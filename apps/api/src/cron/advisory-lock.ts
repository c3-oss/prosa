// Postgres advisory-lock helper for the one-fleet cron skeleton.
//
// `withAdvisoryLock` calls `pg_try_advisory_lock(int8)` for a name-derived
// lock id, runs the work function only if the lock is acquired, and
// releases the lock on every exit path. The lock is non-blocking: if
// another worker is already running the same role, this tick is a
// no-op. That mirrors the spec for the one-fleet model (each cron tick
// at most one fleet-wide runner per role).
//
// The real audit/GC handlers are Lane 8 surface and are not implemented
// here. Lane 4 ships the skeleton (helper + dispatcher) only.

import { createHash } from 'node:crypto'

export type CronRawExec = <T>(sql: string, params?: unknown[]) => Promise<T[]>

export class AdvisoryLockUnavailable extends Error {
  override name = 'AdvisoryLockUnavailable'
  constructor(public readonly lockName: string) {
    super(`advisory lock unavailable: ${lockName}`)
  }
}

/**
 * Hash `lockName` to a stable signed int64 in [-2^63, 2^63). We use the
 * high 8 bytes of a SHA-256 and interpret them as a signed integer so
 * the value fits Postgres's `bigint` advisory-lock id parameter.
 */
export function hashLockNameToInt64(lockName: string): bigint {
  const digest = createHash('sha256').update(lockName, 'utf8').digest()
  const view = new DataView(digest.buffer, digest.byteOffset, 8)
  return view.getBigInt64(0, false)
}

export type WithAdvisoryLockResult<T> = { acquired: true; result: T } | { acquired: false; result: null }

export async function withAdvisoryLock<T>(
  rawExec: CronRawExec,
  lockName: string,
  fn: () => Promise<T>,
): Promise<WithAdvisoryLockResult<T>> {
  const lockId = hashLockNameToInt64(lockName)
  const tryRows = await rawExec<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock',
    [lockId],
  )
  if (!tryRows[0]?.pg_try_advisory_lock) {
    return { acquired: false, result: null }
  }
  try {
    const result = await fn()
    return { acquired: true, result }
  } finally {
    await rawExec('SELECT pg_advisory_unlock($1)', [lockId])
  }
}
