import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ObjectManifestEntry, ProjectionPayload, PromotionReceipt } from '@c3-oss/prosa-sync'
import { CliUserError } from '../errors.js'

const CHECKPOINT_VERSION = 1

export type SyncChunkFingerprintInput = {
  label: string
  objects: ObjectManifestEntry[]
  projection: ProjectionPayload
}

export type SyncCheckpointIdentity = {
  server: string
  tenant: string
  deviceId: string
  storePath: string
}

export type VerifiedSyncChunk = {
  fingerprint: string
  label: string
  batchId: string
  verifiedAt: string
  receipt: PromotionReceipt
}

type SyncCheckpointFile = {
  version: 1
  identity: SyncCheckpointIdentity
  updatedAt: string
  verifiedChunks: Record<string, VerifiedSyncChunk>
}

export type SyncCheckpointHandle = {
  path: string
  isVerified: (fingerprint: string) => boolean
  verifiedChunk: (fingerprint: string) => VerifiedSyncChunk | null
  markVerified: (
    chunk: Omit<VerifiedSyncChunk, 'batchId' | 'verifiedAt'> & { receipt: PromotionReceipt },
  ) => Promise<void>
  release: () => Promise<void>
}

function defaultStateHome(): string {
  const override = process.env.PROSA_STATE_HOME
  if (override && override.length > 0) return override
  const xdg = process.env.XDG_STATE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), '.local', 'state')
  return path.join(base, 'prosa')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function syncCheckpointPath(identity: SyncCheckpointIdentity): string {
  const key = sha256Hex(stableStringify(identity))
  return path.join(defaultStateHome(), 'sync', 'checkpoints', `${key}.json`)
}

export function syncChunkFingerprint(input: SyncChunkFingerprintInput): string {
  return sha256Hex(
    stableStringify({
      version: CHECKPOINT_VERSION,
      label: input.label,
      objects: input.objects,
      projection: input.projection,
    }),
  )
}

async function readCheckpoint(filePath: string, identity: SyncCheckpointIdentity): Promise<SyncCheckpointFile> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SyncCheckpointFile>
    if (parsed.version !== CHECKPOINT_VERSION) throw new Error('unsupported checkpoint version')
    if (stableStringify(parsed.identity) !== stableStringify(identity)) throw new Error('checkpoint identity mismatch')
    return {
      version: CHECKPOINT_VERSION,
      identity,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      verifiedChunks: parsed.verifiedChunks ?? {},
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyCheckpoint(identity)
    }
    throw err
  }
}

function emptyCheckpoint(identity: SyncCheckpointIdentity): SyncCheckpointFile {
  return {
    version: CHECKPOINT_VERSION,
    identity,
    updatedAt: new Date(0).toISOString(),
    verifiedChunks: {},
  }
}

async function writeCheckpoint(filePath: string, checkpoint: SyncCheckpointFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 })
  await rename(tmpPath, filePath)
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  try {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(`${process.pid}\n`)
    return handle
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliUserError(`sync checkpoint is locked by another process: ${lockPath}`)
    }
    throw err
  }
}

export async function resetSyncCheckpoint(identity: SyncCheckpointIdentity): Promise<void> {
  await rm(syncCheckpointPath(identity), { force: true })
}

export async function openSyncCheckpoint({
  identity,
  resume,
}: {
  identity: SyncCheckpointIdentity
  resume: boolean
}): Promise<SyncCheckpointHandle> {
  const filePath = syncCheckpointPath(identity)
  const lockPath = `${filePath}.lock`
  const lock = await acquireLock(lockPath)
  let checkpoint: SyncCheckpointFile
  try {
    checkpoint = resume ? await readCheckpoint(filePath, identity) : emptyCheckpoint(identity)
  } catch (err) {
    await lock.close().catch(() => undefined)
    await rm(lockPath, { force: true })
    throw err
  }
  let released = false

  const save = async () => {
    checkpoint.updatedAt = new Date().toISOString()
    await writeCheckpoint(filePath, checkpoint)
  }

  return {
    path: filePath,
    isVerified: (fingerprint) => Boolean(checkpoint.verifiedChunks[fingerprint]),
    verifiedChunk: (fingerprint) => checkpoint.verifiedChunks[fingerprint] ?? null,
    markVerified: async ({ fingerprint, label, receipt }) => {
      checkpoint.verifiedChunks[fingerprint] = {
        fingerprint,
        label,
        batchId: receipt.batchId,
        verifiedAt: receipt.verifiedAt,
        receipt,
      }
      await save()
    },
    release: async () => {
      if (released) return
      released = true
      await lock.close().catch(() => undefined)
      await rm(lockPath, { force: true })
    },
  }
}
