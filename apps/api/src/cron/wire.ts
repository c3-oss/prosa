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
 * CQ-156 governor-rescope (narrower than the previous draft;
 * recorded under `evidence/lane-08.md`):
 *
 * - Monthly full-byte rehash and GC tombstone/delete transitions DO
 *   have durable cadence gates. The monthly handler skips packs
 *   whose `pack_audit_state.last_full_hash_at` is recent; GC's three
 *   phases gate on `remote_pack.ingested_at`,
 *   `pack_gc_state.first_unreferenced_at + GC_TOMBSTONE_GRACE_HOURS`,
 *   and the unconditional ordering across phases. A restart resets
 *   the per-process `lastFiredMs` but the next tick simply consults
 *   those durable columns and no-ops when the cadence has not
 *   elapsed.
 *
 * - Hourly, daily, and weekly audit sampling DO NOT have durable
 *   cadence gates. After a process or fleet restart, the next tick
 *   can re-run the same hourly sample or daily 4 KiB header probe
 *   it ran before the restart. This duplicate work is bounded by
 *   the advisory lock (only one worker runs a given task body at a
 *   time), the per-tenant sampling caps
 *   (`MAX_HOURLY_AUDIT_OPS_PER_TENANT` etc.), and the fact that
 *   duplicate sampling never publishes new authority or deletes
 *   bytes — it only re-reads `remote_pack` rows and may rewrite
 *   `pack_audit_state.last_*_check_at` timestamps. Authority
 *   correctness, read-side projection, and pack durability are
 *   unaffected. This narrower rescope is the explicit
 *   governor-accepted Lane 8 cadence contract.
 *
 * - Wall-clock cron-of-the-day-of-month semantics (e.g. "monthly on
 *   the 1st at 04:00") are deferred to a node-cron adapter swap;
 *   the per-handler cron expression is recorded in
 *   `CRON_TASK_DEFINITIONS` and surfaces via the injected scheduler
 *   so the swap can be transparent.
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
