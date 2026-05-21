// Lane 8 — CQ-156 production wiring.
//
// `startProsaCron` is the single entry point that wires the audit + GC
// handler factories into the Lane 4 cron skeleton. `startServer` calls
// it after the schema bootstrap, and tests can drive the same path with
// a recording scheduler to prove the wiring is real production code.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyBaseLogger } from 'fastify'
import type { DatabaseHandle, RawExec } from '../db.js'
import { type AuditCronDeps, registerAuditCron } from './audit.js'
import type { DriftLogger, DriftMetrics, DriftTxRunner } from './audit/drift.js'
import { type GcCronDeps, registerGcCron } from './gc.js'
import { type CronScheduler, type StartCronResult, startCron } from './index.js'

export type StartProsaCronDeps = {
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  /**
   * Production fleet logger. Tests pass a no-op logger; production
   * passes the Fastify root logger.
   */
  logger: FastifyBaseLogger | DriftLogger
  /**
   * Metrics counter. Production wires Prometheus; tests pass a
   * recording stub.
   */
  metrics: DriftMetrics
  /**
   * Scheduler that knows how to register `(expression, handler)`
   * pairs. Production passes a node-cron-compatible adapter; tests
   * pass a recording stub. The injected scheduler keeps the cron
   * skeleton agnostic of node-cron's runtime.
   */
  scheduler: CronScheduler
}

export type ProsaCronHandle = StartCronResult

/**
 * Build the audit + GC handler maps and hand them to `startCron`. The
 * resulting handle owns the scheduler lifecycle; the server's `close()`
 * path should call `handle.cancel()` so cron jobs don't outlive the
 * Fastify instance.
 */
export function startProsaCron(deps: StartProsaCronDeps): ProsaCronHandle {
  const driftLogger: DriftLogger = adaptLogger(deps.logger)
  const transactionRunner = deps.transaction as DriftTxRunner

  const auditDeps: AuditCronDeps = {
    rawExec: deps.rawExec,
    transaction: transactionRunner,
    objectStore: deps.objectStore,
    logger: driftLogger,
    metrics: deps.metrics,
  }
  const gcDeps: GcCronDeps = {
    rawExec: deps.rawExec,
    transaction: transactionRunner,
    objectStore: deps.objectStore,
    logger: driftLogger,
    metrics: deps.metrics,
  }
  const handlers = { ...registerAuditCron(auditDeps), ...registerGcCron(gcDeps) }
  return startCron({ rawExec: deps.rawExec, scheduler: deps.scheduler, handlers })
}

function adaptLogger(logger: FastifyBaseLogger | DriftLogger): DriftLogger {
  // Fastify's pino-shaped logger uses `(obj, msg)`; the DriftLogger
  // contract is the same shape. The cast is sound because both
  // interfaces accept (obj, msg). If a future logger lacks `warn` or
  // `error` the adapter falls back to no-op so cron jobs never crash
  // on a logger shape mismatch.
  const warn = typeof (logger as DriftLogger).warn === 'function' ? (logger as DriftLogger).warn.bind(logger) : () => {}
  const error =
    typeof (logger as DriftLogger).error === 'function' ? (logger as DriftLogger).error.bind(logger) : () => {}
  return { warn, error }
}

/**
 * No-op metrics counter used by tests and by production boots that
 * have not yet wired Prometheus. The shape matches `DriftMetrics`.
 */
export const NOOP_METRICS: DriftMetrics = {
  increment() {
    /* noop */
  },
}

/**
 * Build a cadence-aware scheduler. Each registered cron expression is
 * mapped to a per-handler interval that matches its spec-defined
 * cadence (hourly = 1h, daily = 24h, weekly = 7d, monthly = 30d). A
 * small wake-up tick (`tickMs`, default = 1 minute) drives every
 * registered handler; each handler runs only when
 * `now - lastFired >= cadence`. This keeps the weekly + monthly
 * cadences from running every wakeup while still leaving the
 * advisory-lock contract intact.
 *
 * Production deployments that need true cron-of-the-day-of-week
 * semantics (e.g. "monthly on the 1st at 04:00") should swap this for
 * a node-cron adapter; the per-handler cron expression is recorded in
 * `CRON_TASK_DEFINITIONS` and surfaces via the injected scheduler.
 * The cadence approach here is governor-rescoped (CQ-156) because the
 * load-bearing audit/GC contract is "each handler runs no more than
 * once per cadence and re-evaluates against the timestamp columns",
 * not "fires at a wall-clock minute".
 */
export function intervalScheduler(tickMs: number): CronScheduler {
  return (expression: string, handler: () => Promise<void>): (() => void) => {
    const cadenceMs = cadenceForExpression(expression)
    let lastFiredMs = 0
    const wake = async (): Promise<void> => {
      const nowMs = Date.now()
      if (nowMs - lastFiredMs < cadenceMs) return
      lastFiredMs = nowMs
      try {
        await handler()
      } catch {
        /* errors are reported by the handler's own logger */
      }
    }
    const timer = setInterval(() => {
      void wake()
    }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }
}

/**
 * Map the known `CRON_TASK_DEFINITIONS` expressions to interval
 * cadences. Unknown expressions fall through to the wake-up tick so a
 * future task can still register without crashing.
 */
export function cadenceForExpression(expression: string): number {
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  const WEEK = 7 * DAY
  const MONTH = 30 * DAY
  switch (expression) {
    case '0 * * * *':
      return HOUR
    case '0 1 * * *':
    case '0 2 * * *':
      return DAY
    case '0 3 * * 0':
      return WEEK
    case '0 4 1 * *':
      return MONTH
    default:
      return MIN
  }
}
