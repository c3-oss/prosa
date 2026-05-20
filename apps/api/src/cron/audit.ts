// Lane 8 — audit cron handlers.
//
// Four cadences are exposed; each one wraps in an advisory lock so a
// single fleet-wide runner executes the work per tick:
//
//   - hourly  (0.1% sample) — HEAD check against `byte_length`.
//   - daily   (1% sample)   — HEAD + first-4 KiB read to validate the
//                              pack header is present.
//   - weekly  (full scan)   — HEAD on every `remote_pack` row.
//   - monthly (rehash)      — full byte rehash for packs not rehashed in
//                              the last MONTHLY_REHASH_MIN_AGE_DAYS.
//
// The handlers are pure async functions; the Lane 4 cron skeleton owns
// node-cron scheduling. `registerAuditCron` returns the handler map
// ready to be passed to `startCron({ handlers })`.

import { createHash } from 'node:crypto'
import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { RawExec } from '../db.js'
import {
  type DriftDeps,
  type DriftLogger,
  type DriftMetrics,
  type DriftTxRunner,
  markPackHashMismatch,
  markPackMissing,
} from './audit/drift.js'

/** Hard ceiling on packs visited per tenant per hourly tick. */
export const MAX_HOURLY_AUDIT_OPS_PER_TENANT = 100
/** Daily sample size as a fraction of `remote_pack` rows per tenant. */
export const DAILY_AUDIT_SAMPLE_RATIO = 0.01
/** Daily handler floor — every tenant gets at least this many checks. */
export const DAILY_AUDIT_MIN_OPS_PER_TENANT = 10
/** Bytes read from the head of the pack during daily header validation. */
export const DAILY_HEADER_PROBE_BYTES = 4 * 1024
/** Cold-pack threshold for the monthly rehash cadence. */
export const MONTHLY_REHASH_MIN_AGE_DAYS = 90

export type AuditCronDeps = {
  rawExec: RawExec
  transaction: DriftTxRunner
  objectStore: Pick<RemoteObjectStore, 'head' | 'get' | 'getRange'>
  logger: DriftLogger
  metrics: DriftMetrics
  /** Override for tests. Defaults to `Math.random`. */
  random?: () => number
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number
}

export type AuditHandlers = {
  'audit-hourly': () => Promise<void>
  'audit-daily': () => Promise<void>
  'audit-weekly': () => Promise<void>
  'audit-monthly': () => Promise<void>
}

type RemotePackRow = {
  tenant_id: string
  pack_digest: string
  storage_uri: string
  byte_length: string | number
  byte_hash: string | null
}

/**
 * Return the four-handler map keyed by cron task name. Pass directly to
 * `startCron({ handlers })` to wire the Lane 4 skeleton to the Lane 8
 * implementation.
 */
export function registerAuditCron(deps: AuditCronDeps): AuditHandlers {
  return {
    'audit-hourly': () => runAuditHourly(deps),
    'audit-daily': () => runAuditDaily(deps),
    'audit-weekly': () => runAuditWeeklyFullScan(deps),
    'audit-monthly': () => runAuditMonthly(deps),
  }
}

function driftDepsFrom(deps: AuditCronDeps): DriftDeps {
  return { rawExec: deps.rawExec, transaction: deps.transaction, logger: deps.logger, metrics: deps.metrics }
}

/**
 * Hourly: pick at most MAX_HOURLY_AUDIT_OPS_PER_TENANT packs per tenant
 * and HEAD each one. The check is a byte-length parity assertion; any
 * mismatch (including the storage adapter returning null) quarantines
 * the pack and degrades affected receipts.
 */
export async function runAuditHourly(deps: AuditCronDeps): Promise<void> {
  await runHeaderCadence(deps, {
    perTenantCap: MAX_HOURLY_AUDIT_OPS_PER_TENANT,
    includeFullScan: false,
    probeHeader: false,
  })
}

/**
 * Daily: same as hourly plus a 4 KiB header probe so empty or
 * truncated packs surface before the weekly full scan does.
 */
export async function runAuditDaily(deps: AuditCronDeps): Promise<void> {
  await runHeaderCadence(deps, { perTenantCap: null, includeFullScan: false, probeHeader: true })
}

/**
 * Weekly: HEAD + header probe every pack in the tenant. The advisory
 * lock around the cron tick handles tenant-level serialization; the
 * spec budgets this scan at 72 h so cron tick skips are acceptable.
 */
export async function runAuditWeeklyFullScan(deps: AuditCronDeps): Promise<void> {
  await runHeaderCadence(deps, { perTenantCap: null, includeFullScan: true, probeHeader: true })
}

/**
 * Monthly: pick packs whose `pack_audit_state.last_full_hash_at` is
 * older than MONTHLY_REHASH_MIN_AGE_DAYS (or null), download the full
 * pack, recompute the byte hash, and compare against
 * `remote_pack.byte_hash`. Throughput is policed by the cron lock so
 * concurrent fleet workers do not double-charge egress.
 */
export async function runAuditMonthly(deps: AuditCronDeps): Promise<void> {
  const tenants = await loadTenants(deps)
  for (const tenant_id of tenants) {
    const sample = await deps.rawExec<RemotePackRow>(
      `SELECT p.tenant_id, p.pack_digest, p.storage_uri, p.byte_length, p.byte_hash
         FROM remote_pack p
         LEFT JOIN pack_audit_state pa
           ON pa.tenant_id = p.tenant_id
          AND pa.pack_digest = p.pack_digest
        WHERE p.tenant_id = $1
          AND (pa.last_full_hash_at IS NULL
               OR pa.last_full_hash_at < now() - ($2 || ' days')::interval)`,
      [tenant_id, String(MONTHLY_REHASH_MIN_AGE_DAYS)],
    )
    for (const pack of sample) {
      try {
        const stream = await deps.objectStore.get(pack.storage_uri)
        const hash = await hashStream(stream)
        if (pack.byte_hash && pack.byte_hash !== hash) {
          await markPackHashMismatch(driftDepsFrom(deps), tenant_id, pack.pack_digest, 'byte_hash_mismatch')
          continue
        }
        await updateAuditState(deps, tenant_id, pack.pack_digest, {
          last_full_hash_at: true,
          last_header_check_at: true,
        })
      } catch (err) {
        deps.logger.error(
          { err: String(err), tenantId: tenant_id, packDigest: pack.pack_digest },
          'audit monthly error',
        )
      }
    }
  }
}

async function runHeaderCadence(
  deps: AuditCronDeps,
  opts: { perTenantCap: number | null; includeFullScan: boolean; probeHeader: boolean },
): Promise<void> {
  const tenants = await loadTenants(deps)
  for (const tenant_id of tenants) {
    const packs = await sampleTenantPacks(deps, tenant_id, opts)
    for (const pack of packs) {
      try {
        const head = await deps.objectStore.head(pack.storage_uri)
        if (!head) {
          await markPackMissing(driftDepsFrom(deps), tenant_id, pack.pack_digest)
          continue
        }
        const expected = Number(pack.byte_length)
        const observed = inferHeadByteLength(head)
        if (observed !== expected) {
          await markPackHashMismatch(driftDepsFrom(deps), tenant_id, pack.pack_digest, 'byte_length_mismatch')
          continue
        }
        if (opts.probeHeader) {
          const probe = await readHeaderProbe(deps.objectStore, pack.storage_uri, expected)
          if (probe.byteLength === 0) {
            await markPackHashMismatch(driftDepsFrom(deps), tenant_id, pack.pack_digest, 'header_digest_mismatch')
            continue
          }
        }
        await updateAuditState(deps, tenant_id, pack.pack_digest, { last_header_check_at: true })
      } catch (err) {
        deps.logger.error(
          { err: String(err), tenantId: tenant_id, packDigest: pack.pack_digest },
          'audit header cadence error',
        )
      }
    }
  }
}

async function loadTenants(deps: AuditCronDeps): Promise<string[]> {
  const rows = await deps.rawExec<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM remote_pack ORDER BY tenant_id`,
  )
  return rows.map((r) => r.tenant_id)
}

async function sampleTenantPacks(
  deps: AuditCronDeps,
  tenantId: string,
  opts: { perTenantCap: number | null; includeFullScan: boolean; probeHeader: boolean },
): Promise<RemotePackRow[]> {
  if (opts.includeFullScan) {
    return deps.rawExec<RemotePackRow>(
      `SELECT tenant_id, pack_digest, storage_uri, byte_length, byte_hash
         FROM remote_pack
        WHERE tenant_id = $1
        ORDER BY pack_digest`,
      [tenantId],
    )
  }
  if (opts.perTenantCap === MAX_HOURLY_AUDIT_OPS_PER_TENANT) {
    return deps.rawExec<RemotePackRow>(
      `SELECT tenant_id, pack_digest, storage_uri, byte_length, byte_hash
         FROM remote_pack
        WHERE tenant_id = $1
        ORDER BY random()
        LIMIT $2`,
      [tenantId, MAX_HOURLY_AUDIT_OPS_PER_TENANT],
    )
  }
  // Daily cadence: 1% of rows with a floor of DAILY_AUDIT_MIN_OPS_PER_TENANT.
  const counts = await deps.rawExec<{ n: string }>(`SELECT COUNT(*)::text AS n FROM remote_pack WHERE tenant_id = $1`, [
    tenantId,
  ])
  const total = Number(counts[0]?.n ?? '0')
  const target = Math.max(DAILY_AUDIT_MIN_OPS_PER_TENANT, Math.ceil(total * DAILY_AUDIT_SAMPLE_RATIO))
  return deps.rawExec<RemotePackRow>(
    `SELECT tenant_id, pack_digest, storage_uri, byte_length, byte_hash
       FROM remote_pack
      WHERE tenant_id = $1
      ORDER BY random()
      LIMIT $2`,
    [tenantId, target],
  )
}

async function updateAuditState(
  deps: AuditCronDeps,
  tenantId: string,
  packDigest: string,
  fields: { last_header_check_at?: boolean; last_full_hash_at?: boolean },
): Promise<void> {
  const headerTouch = fields.last_header_check_at ? ', last_header_check_at = now()' : ''
  const fullTouch = fields.last_full_hash_at ? ', last_full_hash_at = now()' : ''
  await deps.rawExec(
    `INSERT INTO pack_audit_state (tenant_id, pack_digest, status, last_audit_at, last_header_check_at, last_full_hash_at)
       VALUES ($1, $2, 'ok', now(),
               CASE WHEN $3::boolean THEN now() ELSE NULL END,
               CASE WHEN $4::boolean THEN now() ELSE NULL END)
       ON CONFLICT (tenant_id, pack_digest) DO UPDATE
         SET status = CASE WHEN pack_audit_state.status = 'quarantined' THEN pack_audit_state.status ELSE 'ok' END,
             last_audit_at = now()
             ${headerTouch}
             ${fullTouch}`,
    [tenantId, packDigest, fields.last_header_check_at === true, fields.last_full_hash_at === true],
  )
}

function inferHeadByteLength(head: { compressedSize?: number; uncompressedSize?: number }): number {
  // S3 / FS adapters report the raw on-disk byte length via
  // `compressedSize`; the memory adapter mirrors the same field when
  // it was set by the writer. Fall back to `uncompressedSize` when an
  // adapter omits the on-disk size.
  if (typeof head.compressedSize === 'number') return head.compressedSize
  if (typeof head.uncompressedSize === 'number') return head.uncompressedSize
  return -1
}

async function readHeaderProbe(
  store: Pick<RemoteObjectStore, 'getRange'>,
  storageUri: string,
  totalLength: number,
): Promise<Uint8Array> {
  const length = Math.min(DAILY_HEADER_PROBE_BYTES, Math.max(totalLength, 0))
  if (length === 0) return new Uint8Array(0)
  const stream = await store.getRange(storageUri, 0, length)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash('sha256')
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) hash.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  return hash.digest('hex')
}
