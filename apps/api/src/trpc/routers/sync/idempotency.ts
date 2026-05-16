import { createHash } from 'node:crypto'
import type { CommitUploadInput, CommitUploadOutput } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { headersFromTrpcCtx } from '../../../shared/http.js'
import { TRPCError } from '../../init.js'
import { stableJson } from './manifest.js'
import type { SyncHandlerContext } from './types.js'

const COMMIT_UPLOAD_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_IDEMPOTENCY_KEY_LENGTH = 255

type IdempotencyRow = {
  request_hash: string
  response: unknown | null
}

export type CommitUploadIdempotencyReservation = {
  key: string
  requestHash: string
  replay: CommitUploadOutput | null
}

export async function cleanupExpiredCommitUploadIdempotency(rawExec: RawExec): Promise<number> {
  const rows = await rawExec<{ idempotency_key: string }>(
    `DELETE FROM "sync_commit_idempotency"
      WHERE expires_at <= now()
      RETURNING idempotency_key`,
  )
  return rows.length
}

function commitUploadRequestHash(input: CommitUploadInput): string {
  return `sha256:${createHash('sha256').update(stableJson(input)).digest('hex')}`
}

function readIdempotencyKey(ctx: SyncHandlerContext): string | null {
  const raw = headersFromTrpcCtx(ctx).get('idempotency-key')
  if (raw == null) return null
  const key = raw.trim()
  if (key.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Idempotency-Key must not be empty' })
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Idempotency-Key is too long' })
  }
  return key
}

function parseCommitUploadOutput(value: unknown): CommitUploadOutput {
  if (typeof value === 'string') {
    return JSON.parse(value) as CommitUploadOutput
  }
  return value as CommitUploadOutput
}

export async function reserveCommitUploadIdempotency(
  ctx: SyncHandlerContext,
  input: CommitUploadInput,
): Promise<CommitUploadIdempotencyReservation | null> {
  const key = readIdempotencyKey(ctx)
  if (!key) return null

  await cleanupExpiredCommitUploadIdempotency(ctx.rawExec)

  const requestHash = commitUploadRequestHash(input)
  const expiresAt = new Date(Date.now() + COMMIT_UPLOAD_IDEMPOTENCY_TTL_MS).toISOString()
  const inserted = await ctx.rawExec(
    `INSERT INTO "sync_commit_idempotency"(
       tenant_id, user_id, idempotency_key, request_hash, expires_at
     )
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [ctx.tenantId, ctx.user.id, key, requestHash, expiresAt],
  )
  if (inserted.length > 0) return { key, requestHash, replay: null }

  const rows = await ctx.rawExec<IdempotencyRow>(
    `SELECT request_hash, response
       FROM "sync_commit_idempotency"
      WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3
      LIMIT 1`,
    [ctx.tenantId, ctx.user.id, key],
  )
  const existing = rows[0]
  if (!existing) return reserveCommitUploadIdempotency(ctx, input)
  if (existing.request_hash !== requestHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Idempotency-Key was already used with a different sync.commitUpload request',
    })
  }
  if (existing.response != null) {
    ctx.res.header('x-prosa-idempotent-replay', 'true')
    return { key, requestHash, replay: parseCommitUploadOutput(existing.response) }
  }
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'A sync.commitUpload request with this Idempotency-Key is already in progress',
  })
}

export async function storeCommitUploadIdempotencyResponse(opts: {
  rawExec: RawExec
  tenantId: string
  userId: string
  reservation: CommitUploadIdempotencyReservation
  response: CommitUploadOutput
}): Promise<void> {
  const rows = await opts.rawExec(
    `UPDATE "sync_commit_idempotency"
        SET response = $4::jsonb, updated_at = now()
      WHERE tenant_id = $1
        AND user_id = $2
        AND idempotency_key = $3
        AND request_hash = $5
      RETURNING idempotency_key`,
    [opts.tenantId, opts.userId, opts.reservation.key, JSON.stringify(opts.response), opts.reservation.requestHash],
  )
  if (rows.length === 0) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to store idempotent commit response' })
  }
}

export async function releaseCommitUploadIdempotency(opts: {
  rawExec: RawExec
  tenantId: string
  userId: string
  reservation: CommitUploadIdempotencyReservation
}): Promise<void> {
  await opts.rawExec(
    `DELETE FROM "sync_commit_idempotency"
      WHERE tenant_id = $1
        AND user_id = $2
        AND idempotency_key = $3
        AND request_hash = $4
        AND response IS NULL`,
    [opts.tenantId, opts.userId, opts.reservation.key, opts.reservation.requestHash],
  )
}
