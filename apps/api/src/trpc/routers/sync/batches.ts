import { randomUUID } from 'node:crypto'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'

export type LockedBatchRow = {
  id: string
  status: string
  store_path: string
}

export type VerificationBatchRow = LockedBatchRow & {
  device_id: string
  user_id: string
}

export async function markBatchFailed(
  rawExec: RawExec,
  batchId: string,
  tenantId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await rawExec(
    'UPDATE "sync_batch" SET status = $1, error = $2::jsonb, updated_at = now() WHERE id = $3 AND tenant_id = $4',
    ['failed', JSON.stringify({ message }), batchId, tenantId],
  )
}

export async function requireDeviceAccess(opts: {
  rawExec: RawExec
  tenantId: string
  userId: string
  deviceId: string
  storePath: string
}): Promise<void> {
  const rows = await opts.rawExec<{ id: string }>(
    `SELECT id FROM "device"
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND store_path = $4 AND revoked_at IS NULL
       LIMIT 1`,
    [opts.deviceId, opts.tenantId, opts.userId, opts.storePath],
  )
  if (!rows[0]) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Device is not authorized for this tenant/store' })
  }
}

export async function ensureDevice(opts: {
  rawExec: RawExec
  tenantId: string
  userId: string
  deviceName: string
  platform?: string
  cliVersion: string
  storePath: string
}): Promise<string> {
  const { rawExec, tenantId, userId, deviceName, platform, cliVersion, storePath } = opts
  const found = await rawExec<{ id: string }>(
    'SELECT id FROM "device" WHERE tenant_id = $1 AND user_id = $2 AND name = $3 LIMIT 1',
    [tenantId, userId, deviceName],
  )
  if (found[0]) {
    await rawExec(
      'UPDATE "device" SET last_seen_at = now(), platform = COALESCE($1, platform), cli_version = $2, store_path = $3 WHERE id = $4',
      [platform ?? null, cliVersion, storePath, found[0].id],
    )
    return found[0].id
  }
  const id = `dev_${randomUUID()}`
  await rawExec(
    'INSERT INTO "device"(id, tenant_id, user_id, name, platform, cli_version, store_path) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, tenantId, userId, deviceName, platform ?? null, cliVersion, storePath],
  )
  return id
}

export async function requireOpenBatchForCommit(opts: {
  rawExec: RawExec
  batchId: string
  tenantId: string
  deviceId: string
  userId: string
  storePath: string
}): Promise<LockedBatchRow> {
  const rows = await opts.rawExec<LockedBatchRow>(
    `SELECT id, status, store_path FROM "sync_batch"
       WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND user_id = $4
       FOR UPDATE`,
    [opts.batchId, opts.tenantId, opts.deviceId, opts.userId],
  )
  const batch = rows[0]
  if (!batch) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown batch' })
  }
  if (batch.store_path !== opts.storePath) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch storePath mismatch' })
  }
  if (batch.status !== 'open') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch is not open for commit' })
  }
  return batch
}

export async function requireCommittedBatchForVerification(opts: {
  rawExec: RawExec
  batchId: string
  tenantId: string
  userId: string
  storePath: string
}): Promise<VerificationBatchRow> {
  const rows = await opts.rawExec<VerificationBatchRow>(
    'SELECT id, device_id, status, user_id, store_path FROM "sync_batch" WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE',
    [opts.batchId, opts.tenantId, opts.userId],
  )
  const batch = rows[0]
  if (!batch) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown batch' })
  }
  if (batch.store_path !== opts.storePath) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch storePath mismatch' })
  }
  if (batch.status !== 'committed') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Batch must be committed before verification',
    })
  }
  return batch
}

export async function requireVerifiedBatchForCleanup(opts: {
  rawExec: RawExec
  batchId: string
  tenantId: string
  storePath: string
}): Promise<LockedBatchRow> {
  const rows = await opts.rawExec<LockedBatchRow>(
    'SELECT id, status, store_path FROM "sync_batch" WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [opts.batchId, opts.tenantId],
  )
  const batch = rows[0]
  if (!batch) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown batch' })
  }
  if (batch.store_path !== opts.storePath) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch storePath mismatch' })
  }
  if (batch.status !== 'verified') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch must be verified before cleanup ack' })
  }
  return batch
}
