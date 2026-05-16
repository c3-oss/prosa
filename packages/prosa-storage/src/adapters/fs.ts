import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  type ObjectMeta,
  PUT_PREVERIFIED_BYTES,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  asyncIterableToUint8Array,
} from '../types.js'
import { assertNoConflict, verifyBytes } from '../verify.js'

const LOCK_RETRY_MS = 5

/**
 * Filesystem-backed object store. Single-node, suitable for self-host or
 * local development; not safe across machines without a shared volume.
 *
 * Layout:
 *   <root>/<storage-key>           — bytes
 *   <root>/<storage-key>.meta.json — sidecar with declared metadata
 */
export class FsObjectStore implements RemoteObjectStore {
  private readonly root: string

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory)
  }

  private resolveKey(key: string): { absolute: string; metaPath: string } {
    if (key.includes('..')) {
      throw new Error(`FsObjectStore: path traversal denied for ${key}`)
    }
    const absolute = join(this.root, key)
    return { absolute, metaPath: `${absolute}.meta.json` }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const { absolute, metaPath } = this.resolveKey(key)
    return readExisting(absolute, metaPath)
  }

  async putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    return this.putLocked(key, bytes, meta, { verify: true })
  }

  async [PUT_PREVERIFIED_BYTES](key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    return this.putLocked(key, bytes, meta, { verify: false })
  }

  private async putLocked(
    key: string,
    bytes: AsyncIterable<Uint8Array>,
    meta: PutMeta,
    opts: { verify: boolean },
  ): Promise<PutResult> {
    const { absolute, metaPath } = this.resolveKey(key)
    await mkdir(dirname(absolute), { recursive: true })
    const release = await acquireFileLock(`${absolute}.lock`)
    let wroteFinalBytes = false
    const metaTmp = `${metaPath}.${randomUUID()}.tmp`
    try {
      const existing = await readExisting(absolute, metaPath)
      if (existing) {
        assertNoConflict(existing, meta)
        return { meta: existing, alreadyExisted: true }
      }

      // A previous writer may have crashed after creating bytes but before
      // committing metadata. The sidecar is the commit marker, so discard the
      // uncommitted bytes while holding the per-key lock.
      await rm(absolute, { force: true })

      const buffer = await asyncIterableToUint8Array(bytes)
      if (opts.verify) verifyBytes(buffer, meta)
      const handle = await open(absolute, 'wx')
      try {
        await handle.writeFile(buffer)
      } finally {
        await handle.close()
      }
      wroteFinalBytes = true

      const stored: ObjectMeta = { ...meta, storageKey: key }
      await writeFile(metaTmp, JSON.stringify(stored), { flag: 'wx' })
      await rename(metaTmp, metaPath)
      return { meta: stored, alreadyExisted: false }
    } catch (err) {
      await rm(metaTmp, { force: true })
      if (wroteFinalBytes) {
        await rm(absolute, { force: true })
      }
      throw err
    } finally {
      await release()
    }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const { absolute } = this.resolveKey(key)
    await stat(absolute)
    return Readable.toWeb(createReadStream(absolute)) as ReadableStream<Uint8Array>
  }

  async delete(key: string): Promise<void> {
    const { absolute, metaPath } = this.resolveKey(key)
    const release = await acquireFileLock(`${absolute}.lock`)
    try {
      await rm(absolute, { force: true })
      await rm(metaPath, { force: true })
    } finally {
      await release()
    }
  }
}

async function readExisting(absolute: string, metaPath: string): Promise<ObjectMeta | null> {
  try {
    await stat(absolute)
    const text = await readFile(metaPath, 'utf8')
    return JSON.parse(text) as ObjectMeta
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw err
  }
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      return async () => {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
      await sleep(LOCK_RETRY_MS)
    }
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string }).code
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
