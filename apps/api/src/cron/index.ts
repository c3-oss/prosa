// One-fleet cron skeleton.
//
// The Lane 8 audit and GC handlers are intentionally not implemented in
// Lane 4. This module ships:
//
// - The audit + GC role definitions (`CRON_TASK_DEFINITIONS`), each
//   carrying a cron schedule string and an advisory-lock name.
// - `defineCronTask` for ad-hoc task registration.
// - `startCron`, which iterates the registered tasks and hands them to
//   an injected `scheduler`. Production-mode boot will pass
//   `node-cron`'s `cron.schedule`; tests pass a stub scheduler so the
//   skeleton can be exercised without a clock.
//
// The handler bodies wrap themselves in `withAdvisoryLock(lockName)`
// before invoking the (still placeholder) audit/GC functions. That way
// the lock contract — at most one fleet-wide runner per tick — is
// already enforced by the time Lane 8 fills the handlers in.

import { type CronRawExec, type WithAdvisoryLockResult, withAdvisoryLock } from './advisory-lock.js'

export type CronTaskRole = 'audit' | 'gc'

export type CronTaskDefinition = {
  /** Stable identifier — used for both logging and the advisory-lock name. */
  name: string
  /** node-cron-compatible expression. */
  schedule: string
  role: CronTaskRole
  /** Advisory-lock name for `pg_try_advisory_lock`. */
  lockName: string
}

export const CRON_TASK_DEFINITIONS: readonly CronTaskDefinition[] = [
  // Audit roles (Lane 8 will implement the handlers).
  { name: 'audit-hourly', schedule: '0 * * * *', role: 'audit', lockName: 'prosa-audit-hourly' },
  { name: 'audit-daily', schedule: '0 2 * * *', role: 'audit', lockName: 'prosa-audit-daily' },
  { name: 'audit-weekly', schedule: '0 3 * * 0', role: 'audit', lockName: 'prosa-audit-weekly' },
  { name: 'audit-monthly', schedule: '0 4 1 * *', role: 'audit', lockName: 'prosa-audit-monthly' },
  // GC role (Lane 8 will implement the handler).
  { name: 'gc-daily', schedule: '0 1 * * *', role: 'gc', lockName: 'prosa-gc-daily' },
]

export type CronHandler = () => Promise<WithAdvisoryLockResult<void>>

export type CronScheduler = (cronExpression: string, handler: () => Promise<void>) => () => void

export type CronDeps = {
  rawExec: CronRawExec
  scheduler: CronScheduler
  /**
   * Optional override map: `name -> handler body`. The cron skeleton
   * always wraps the body in `withAdvisoryLock`, so a handler body that
   * is omitted simply runs as a no-op under the lock. Lane 8 will
   * populate the real bodies.
   */
  handlers?: Partial<Record<string, () => Promise<void>>>
}

export type StartCronResult = {
  registered: CronTaskDefinition[]
  cancel: () => void
}

export function startCron(deps: CronDeps): StartCronResult {
  const cancels: Array<() => void> = []
  for (const def of CRON_TASK_DEFINITIONS) {
    const body = deps.handlers?.[def.name] ?? noopHandler
    const wrapped = async () => {
      await withAdvisoryLock(deps.rawExec, def.lockName, body)
    }
    const cancel = deps.scheduler(def.schedule, wrapped)
    cancels.push(cancel)
  }
  return {
    registered: [...CRON_TASK_DEFINITIONS],
    cancel: () => {
      for (const c of cancels) c()
    },
  }
}

async function noopHandler(): Promise<void> {
  // Intentional no-op: Lane 8 wires the real audit/GC bodies. Until
  // then, the skeleton still acquires + releases the advisory lock
  // each tick so the contract is exercised end-to-end.
}

export { hashLockNameToInt64, withAdvisoryLock } from './advisory-lock.js'
export type { CronRawExec, WithAdvisoryLockResult } from './advisory-lock.js'
