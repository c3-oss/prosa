// CAS pack writer pool.
//
// 8 small writers sharded by `blake3(object_id)[0:8] mod 8` plus 2 large
// writers for objects ≥ 32 MiB (single-entry standalone packs). Each
// small writer buffers entries until any rollover trigger fires:
//
//   target_pack_bytes = 64 MiB   (advisory; we close on the first trigger)
//   max_pack_bytes    = 128 MiB  (hard ceiling)
//   max_objects       = 65536
//   max_open_ms       = 2000     (latency ceiling)
//
// The pool emits finalized packs as `cas/packs/pack-<digest>.prosa-cas-pack`
// (small) or `cas/large/<object_id-hex>.zst`-style files (large). For
// Lane 1 we keep both flavours framed identically with `PROSA_CAS_PACK_2`
// magic; the `standalone_large_object` header flag distinguishes them.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { blake3 } from '@noble/hashes/blake3'

import { toHex } from '@c3-oss/prosa-types-v2'

import { type CasPackBuilt, type CasPackInput, buildCasPack } from './cas-pack.js'

export const LARGE_OBJECT_THRESHOLD_BYTES = 32 * 1024 * 1024 // 32 MiB
export const SMALL_WRITER_COUNT = 8
export const LARGE_WRITER_COUNT = 2

export type CasRolloverTriggers = {
  /** Soft target; first trigger to fire rotates the pack. */
  targetPackBytes: number
  /** Hard ceiling; any incoming object that would push past this rotates first. */
  maxPackBytes: number
  /** Max entry count per pack. */
  maxObjects: number
  /** Max time (ms) a pack may stay open before rotation. */
  maxOpenMs: number
}

export const DEFAULT_CAS_TRIGGERS: CasRolloverTriggers = {
  targetPackBytes: 64 * 1024 * 1024,
  maxPackBytes: 128 * 1024 * 1024,
  maxObjects: 65536,
  maxOpenMs: 2000,
}

export type CasPoolOptions = {
  /** Root directory of `cas/`. Writers create `packs/` and `large/` under it. */
  casDir: string
  triggers?: Partial<CasRolloverTriggers>
  /** Canonical timestamp factory; defaulted to `() => new Date().toISOString()` style upstream. */
  createdAt: () => string
  /** Test hook for the clock. */
  now?: () => number
  /** Optional override for the large-object threshold (tests). */
  largeObjectThresholdBytes?: number
}

export type CasPoolAppendResult = {
  object_id: string // blake3:<hex>
  shardId: number
  isLarge: boolean
  /** Pack that this object landed in, populated after the pack closes. */
  packDigest: string | null
  packPath: string | null
}

export type CasPackEmission = {
  shardId: number
  isLarge: boolean
  packDigest: string
  packPath: string
  built: CasPackBuilt
}

class SmallPackWriter {
  private buffered: CasPackInput[] = []
  private bytesPending = 0
  private openedAt: number | null = null

  constructor(
    public readonly shardId: number,
    private readonly pool: CasPackWriterPool,
    private readonly triggers: CasRolloverTriggers,
  ) {}

  buffered_size(): number {
    return this.buffered.length
  }

  /**
   * Append an object. Returns `null` if no rotation occurred, otherwise
   * the emitted pack metadata.
   */
  async append(input: CasPackInput): Promise<CasPackEmission | null> {
    // Pre-rotate when adding would push past the hard ceiling.
    if (this.bytesPending + input.bytes.length > this.triggers.maxPackBytes && this.buffered.length > 0) {
      const emission = await this.finalize()
      this.buffered.push(input)
      this.bytesPending = input.bytes.length
      this.openedAt = this.pool.now()
      return emission
    }
    if (this.openedAt === null) this.openedAt = this.pool.now()
    this.buffered.push(input)
    this.bytesPending += input.bytes.length
    if (
      this.bytesPending >= this.triggers.targetPackBytes ||
      this.buffered.length >= this.triggers.maxObjects ||
      this.pool.now() - this.openedAt >= this.triggers.maxOpenMs
    ) {
      return this.finalize()
    }
    return null
  }

  async finalize(): Promise<CasPackEmission | null> {
    if (this.buffered.length === 0) return null
    const inputs = this.buffered
    this.buffered = []
    this.bytesPending = 0
    this.openedAt = null
    return this.pool.emitSmallPack(this.shardId, inputs)
  }
}

class LargePackWriter {
  constructor(
    public readonly shardId: number,
    private readonly pool: CasPackWriterPool,
  ) {}

  async append(input: CasPackInput): Promise<CasPackEmission> {
    return this.pool.emitLargePack(this.shardId, input)
  }
}

export class CasPackWriterPool {
  readonly casDir: string
  readonly packsDir: string
  readonly largeDir: string
  readonly triggers: CasRolloverTriggers
  readonly createdAt: () => string
  readonly largeObjectThreshold: number
  readonly now: () => number

  private readonly smalls: SmallPackWriter[]
  private readonly larges: LargePackWriter[]
  private largeRotor = 0
  /** Aggregated set of object_ids the pool has admitted. */
  private readonly seenObjectIds: Set<string> = new Set()

  constructor(options: CasPoolOptions) {
    this.casDir = options.casDir
    this.packsDir = join(options.casDir, 'packs')
    this.largeDir = join(options.casDir, 'large')
    this.triggers = { ...DEFAULT_CAS_TRIGGERS, ...options.triggers }
    this.createdAt = options.createdAt
    this.largeObjectThreshold = options.largeObjectThresholdBytes ?? LARGE_OBJECT_THRESHOLD_BYTES
    this.now = options.now ?? Date.now
    this.smalls = Array.from({ length: SMALL_WRITER_COUNT }, (_, i) => new SmallPackWriter(i, this, this.triggers))
    this.larges = Array.from({ length: LARGE_WRITER_COUNT }, (_, i) => new LargePackWriter(i, this))
  }

  /**
   * Append an object. The pool computes its object_id and dispatches to
   * either a small-writer shard or a large-writer (≥ threshold).
   *
   * If the call closes a small pack, `packDigest` and `packPath` are
   * populated; otherwise both are null and the object lives in a
   * still-open buffer.
   */
  async appendObject(input: CasPackInput): Promise<CasPoolAppendResult> {
    const objectIdBytes = blake3(input.bytes)
    const objectIdHex = toHex(objectIdBytes)
    const objectId = `blake3:${objectIdHex}`
    if (this.seenObjectIds.has(objectId)) {
      // Already admitted; the pool dedupes at the object-id level.
      return { object_id: objectId, shardId: -1, isLarge: false, packDigest: null, packPath: null }
    }
    this.seenObjectIds.add(objectId)

    if (input.bytes.length >= this.largeObjectThreshold) {
      const shardId = this.largeRotor
      this.largeRotor = (this.largeRotor + 1) % LARGE_WRITER_COUNT
      const writer = this.larges[shardId] as LargePackWriter
      const emission = await writer.append(input)
      return {
        object_id: objectId,
        shardId,
        isLarge: true,
        packDigest: emission.packDigest,
        packPath: emission.packPath,
      }
    }

    const shardId = readU64BE(objectIdBytes) % BigInt(SMALL_WRITER_COUNT)
    const shard = Number(shardId)
    const writer = this.smalls[shard] as SmallPackWriter
    const emission = await writer.append(input)
    return {
      object_id: objectId,
      shardId: shard,
      isLarge: false,
      packDigest: emission?.packDigest ?? null,
      packPath: emission?.packPath ?? null,
    }
  }

  /** Force-finalize every open small pack. Large writers have no buffered state. */
  async flushAll(): Promise<CasPackEmission[]> {
    const out: CasPackEmission[] = []
    for (const s of this.smalls) {
      const e = await s.finalize()
      if (e) out.push(e)
    }
    return out
  }

  /** Number of objects currently buffered in any small writer. */
  bufferedCount(): number {
    let n = 0
    for (const s of this.smalls) n += s.buffered_size()
    return n
  }

  // ---------------------------------------------------------------
  // Emission helpers (called by the writers).
  // ---------------------------------------------------------------

  async emitSmallPack(shardId: number, inputs: readonly CasPackInput[]): Promise<CasPackEmission> {
    const built = buildCasPack(inputs, { createdAt: this.createdAt() })
    const packPath = join(this.packsDir, `pack-${stripBlake3(built.packDigest)}.prosa-cas-pack`)
    await mkdir(this.packsDir, { recursive: true })
    await writeFile(packPath, built.bytes)
    return { shardId, isLarge: false, packDigest: built.packDigest, packPath, built }
  }

  async emitLargePack(shardId: number, input: CasPackInput): Promise<CasPackEmission> {
    const built = buildCasPack([input], { createdAt: this.createdAt(), standaloneLargeObject: true })
    const packPath = join(this.largeDir, `pack-${stripBlake3(built.packDigest)}.prosa-cas-pack`)
    await mkdir(this.largeDir, { recursive: true })
    await writeFile(packPath, built.bytes)
    return { shardId, isLarge: true, packDigest: built.packDigest, packPath, built }
  }
}

function readU64BE(bytes: Uint8Array): bigint {
  let acc = 0n
  for (let i = 0; i < 8; i++) acc = (acc << 8n) | BigInt(bytes[i] as number)
  return acc
}

function stripBlake3(d: string): string {
  return d.startsWith('blake3:') ? d.slice('blake3:'.length) : d
}
