// Raw-source pack writer pool.
//
// 4 writers sharded by `blake3(source_file_id)[0:8] mod 4`. Rollover
// triggers mirror the CAS pool (size, count, age) so the same operational
// shape governs both. Each finalized pack lands at
// `raw_sources/packs/source-pack-<digest>.prosa-raw-pack`.

import { join } from 'node:path'

import { blake3 } from '@noble/hashes/blake3'

import { writeFileDurable } from '../util/durable-write.js'
import { type CasRolloverTriggers, DEFAULT_CAS_TRIGGERS } from './cas-writer.js'
import { type RawSourcePackBuilt, type RawSourcePackInput, buildRawSourcePack } from './raw-source-pack.js'

export const RAW_WRITER_COUNT = 4

export type RawSourcePoolOptions = {
  /** Root directory of `raw_sources/`. */
  rawSourcesDir: string
  triggers?: Partial<CasRolloverTriggers>
  createdAt: () => string
  now?: () => number
}

export type RawSourcePoolAppendResult = {
  source_file_id: string
  shardId: number
  packDigest: string | null
  packPath: string | null
}

export type RawSourcePackEmission = {
  shardId: number
  packDigest: string
  packPath: string
  built: RawSourcePackBuilt
}

class RawShardWriter {
  private buffered: RawSourcePackInput[] = []
  private bytesPending = 0
  private openedAt: number | null = null

  constructor(
    public readonly shardId: number,
    private readonly pool: RawSourcePackWriterPool,
    private readonly triggers: CasRolloverTriggers,
  ) {}

  bufferedSize(): number {
    return this.buffered.length
  }

  async append(input: RawSourcePackInput): Promise<RawSourcePackEmission | null> {
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

  async finalize(): Promise<RawSourcePackEmission | null> {
    if (this.buffered.length === 0) return null
    const inputs = this.buffered
    this.buffered = []
    this.bytesPending = 0
    this.openedAt = null
    return this.pool.emitPack(this.shardId, inputs)
  }
}

export class RawSourcePackWriterPool {
  readonly rawSourcesDir: string
  readonly packsDir: string
  readonly triggers: CasRolloverTriggers
  readonly createdAt: () => string
  readonly now: () => number

  private readonly writers: RawShardWriter[]
  private readonly seenSourceFileIds: Set<string> = new Set()

  constructor(options: RawSourcePoolOptions) {
    this.rawSourcesDir = options.rawSourcesDir
    this.packsDir = join(options.rawSourcesDir, 'packs')
    this.triggers = { ...DEFAULT_CAS_TRIGGERS, ...options.triggers }
    this.createdAt = options.createdAt
    this.now = options.now ?? Date.now
    this.writers = Array.from({ length: RAW_WRITER_COUNT }, (_, i) => new RawShardWriter(i, this, this.triggers))
  }

  /**
   * Append a raw-source file. Returns the assigned shard plus, when the
   * append closes a pack, the finalized pack metadata.
   *
   * Dedup is enforced at the `source_file_id` level: re-appending the
   * same source_file_id is a no-op.
   */
  async appendSourceFile(input: RawSourcePackInput): Promise<RawSourcePoolAppendResult> {
    if (this.seenSourceFileIds.has(input.source_file_id)) {
      return { source_file_id: input.source_file_id, shardId: -1, packDigest: null, packPath: null }
    }
    this.seenSourceFileIds.add(input.source_file_id)
    const shardId = Number(readU64BE(blake3(new TextEncoder().encode(input.source_file_id))) % BigInt(RAW_WRITER_COUNT))
    const writer = this.writers[shardId] as RawShardWriter
    const emission = await writer.append(input)
    return {
      source_file_id: input.source_file_id,
      shardId,
      packDigest: emission?.packDigest ?? null,
      packPath: emission?.packPath ?? null,
    }
  }

  async flushAll(): Promise<RawSourcePackEmission[]> {
    const out: RawSourcePackEmission[] = []
    for (const w of this.writers) {
      const e = await w.finalize()
      if (e) out.push(e)
    }
    return out
  }

  bufferedCount(): number {
    let n = 0
    for (const w of this.writers) n += w.bufferedSize()
    return n
  }

  async emitPack(shardId: number, inputs: readonly RawSourcePackInput[]): Promise<RawSourcePackEmission> {
    const built = buildRawSourcePack(inputs, { createdAt: this.createdAt() })
    const packPath = join(this.packsDir, `source-pack-${stripBlake3(built.packDigest)}.prosa-raw-pack`)
    await writeFileDurable(packPath, built.bytes)
    return { shardId, packDigest: built.packDigest, packPath, built }
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
