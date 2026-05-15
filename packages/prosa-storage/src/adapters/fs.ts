import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  type ObjectMeta,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  asyncIterableToUint8Array,
} from '../types.js'
import { assertNoConflict, verifyBytes } from '../verify.js'

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
    if (!existsSync(absolute) || !existsSync(metaPath)) return null
    const text = await readFile(metaPath, 'utf8')
    const meta = JSON.parse(text) as ObjectMeta
    return meta
  }

  async putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    const { absolute, metaPath } = this.resolveKey(key)
    if (existsSync(absolute) && existsSync(metaPath)) {
      const existing = JSON.parse(await readFile(metaPath, 'utf8')) as ObjectMeta
      assertNoConflict(existing, meta)
      return { meta: existing, alreadyExisted: true }
    }
    const buffer = await asyncIterableToUint8Array(bytes)
    verifyBytes(buffer, meta)
    await mkdir(dirname(absolute), { recursive: true })
    const tmp = `${absolute}.${randomUUID()}.tmp`
    await writeFile(tmp, buffer)
    await rename(tmp, absolute)
    const stored: ObjectMeta = { ...meta, storageKey: key }
    await writeFile(metaPath, JSON.stringify(stored))
    return { meta: stored, alreadyExisted: false }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const { absolute } = this.resolveKey(key)
    await stat(absolute)
    return Readable.toWeb(createReadStream(absolute)) as ReadableStream<Uint8Array>
  }

  async delete(key: string): Promise<void> {
    const { absolute, metaPath } = this.resolveKey(key)
    await rm(absolute, { force: true })
    await rm(metaPath, { force: true })
  }
}
