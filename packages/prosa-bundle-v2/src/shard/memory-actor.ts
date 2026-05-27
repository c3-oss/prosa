// In-memory ShardActor implementation backed by a per-shard append log on
// disk for crash recovery. The lane doc calls for RocksDB, but the
// canonical command semantics are storage-agnostic — this implementation
// satisfies the same contract while we keep the native RocksDB binding
// out of the dev loop. The RocksDB backend can replace this class without
// any consumer change.
//
// Persistence model:
//   - Each shard owns a single append-only log file: `shard-<i>.log`.
//   - Every successful `apply()` appends a JSON line describing the
//     command and its outcome.
//   - `open()` replays the log to rebuild in-memory maps.
//   - Reservations are NOT persisted across restarts (they expire on
//     restart, matching the TTL semantics).

import { mkdir, open as openFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  ActiveReservation,
  Keyspace,
  ReserveOwner,
  ShardActor,
  ShardCommand,
  ShardResponse,
  ShardSnapshot,
  StoredEntry,
} from './commands.js'

type KeyMap<V> = Map<string, V>

function keyToString(key: Uint8Array): string {
  // Hex is canonical for byte keys — readable in logs and stable across
  // platforms.
  let out = ''
  for (const b of key) out += b.toString(16).padStart(2, '0')
  return out
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64')
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

type LogRecord =
  | { op: 'put_if_absent'; keyspace: Keyspace; key: string; value: string }
  | { op: 'commit_reservation'; keyspace: Keyspace; key: string; value: string }

export class MemoryShardActor implements ShardActor {
  private readonly entries: Map<Keyspace, KeyMap<StoredEntry>> = new Map()
  private readonly reservations: Map<Keyspace, KeyMap<ActiveReservation>> = new Map()
  private logFd: import('node:fs/promises').FileHandle | null = null
  private now: () => number = Date.now

  private constructor(
    public readonly shardId: number,
    public readonly logPath: string | null,
  ) {}

  /** Create an in-memory-only shard actor (no disk persistence). */
  static memoryOnly(shardId: number): MemoryShardActor {
    return new MemoryShardActor(shardId, null)
  }

  /** Open or create a persistent shard actor backed by `logPath`. */
  static async openPersistent(shardId: number, logPath: string): Promise<MemoryShardActor> {
    const actor = new MemoryShardActor(shardId, logPath)
    await mkdir(dirname(logPath), { recursive: true })
    // Replay existing log entries.
    let raw = ''
    try {
      raw = await readFile(logPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      const record = JSON.parse(line) as LogRecord
      const entries = actor.entriesFor(record.keyspace)
      entries.set(record.key, {
        value: base64ToBytes(record.value),
        committedEpoch: null,
      })
    }
    actor.logFd = await openFile(logPath, 'a')
    return actor
  }

  /** Test hook: override the clock. */
  setClock(now: () => number): void {
    this.now = now
  }

  private entriesFor(keyspace: Keyspace): KeyMap<StoredEntry> {
    let m = this.entries.get(keyspace)
    if (!m) {
      m = new Map()
      this.entries.set(keyspace, m)
    }
    return m
  }

  private reservationsFor(keyspace: Keyspace): KeyMap<ActiveReservation> {
    let m = this.reservations.get(keyspace)
    if (!m) {
      m = new Map()
      this.reservations.set(keyspace, m)
    }
    return m
  }

  private isReservationActive(r: ActiveReservation | undefined): r is ActiveReservation {
    return r !== undefined && r.expiresAt > this.now()
  }

  private sameOwner(a: ReserveOwner, b: ReserveOwner): boolean {
    if (a.ownerId !== b.ownerId) return false
    if ((a.sourceTool ?? '') !== (b.sourceTool ?? '')) return false
    return true
  }

  private async appendLog(record: LogRecord): Promise<void> {
    if (!this.logFd) return
    await this.logFd.appendFile(`${JSON.stringify(record)}\n`)
    await this.logFd.sync()
  }

  async apply(command: ShardCommand): Promise<ShardResponse> {
    const keyStr = keyToString(command.key)
    switch (command.op) {
      case 'PutIfAbsent': {
        const entries = this.entriesFor(command.keyspace)
        const existing = entries.get(keyStr)
        if (existing) return { ok: true, existed: true, value: existing.value }
        // If an active reservation exists for the same key, PutIfAbsent
        // does not bypass it — the writer must use CommitReservation.
        const r = this.reservationsFor(command.keyspace).get(keyStr)
        if (this.isReservationActive(r)) {
          return { ok: false, error: 'reserved_by_other' }
        }
        entries.set(keyStr, { value: command.value, committedEpoch: null })
        await this.appendLog({
          op: 'put_if_absent',
          keyspace: command.keyspace,
          key: keyStr,
          value: bytesToBase64(command.value),
        })
        return { ok: true, existed: false, value: command.value }
      }

      case 'Reserve': {
        const entries = this.entriesFor(command.keyspace)
        if (entries.has(keyStr)) {
          return { ok: true, existed: true, value: entries.get(keyStr)?.value ?? null }
        }
        const reservations = this.reservationsFor(command.keyspace)
        const current = reservations.get(keyStr)
        if (this.isReservationActive(current)) {
          if (this.sameOwner(current.owner, command.owner)) {
            // Same owner re-reserves: extend TTL.
            reservations.set(keyStr, { owner: command.owner, expiresAt: this.now() + command.ttlMs })
            return { ok: true, existed: false, value: null }
          }
          return { ok: false, error: 'reserved_by_other' }
        }
        reservations.set(keyStr, { owner: command.owner, expiresAt: this.now() + command.ttlMs })
        return { ok: true, existed: false, value: null }
      }

      case 'CommitReservation': {
        const reservations = this.reservationsFor(command.keyspace)
        const current = reservations.get(keyStr)
        if (!current) return { ok: false, error: 'not_found' }
        if (!this.isReservationActive(current)) {
          reservations.delete(keyStr)
          return { ok: false, error: 'reservation_expired' }
        }
        if (!this.sameOwner(current.owner, command.owner)) {
          return { ok: false, error: 'reserved_by_other' }
        }
        const entries = this.entriesFor(command.keyspace)
        if (entries.has(keyStr)) {
          reservations.delete(keyStr)
          return { ok: true, existed: true, value: entries.get(keyStr)?.value ?? null }
        }
        entries.set(keyStr, { value: command.value, committedEpoch: null })
        reservations.delete(keyStr)
        await this.appendLog({
          op: 'commit_reservation',
          keyspace: command.keyspace,
          key: keyStr,
          value: bytesToBase64(command.value),
        })
        return { ok: true, existed: false, value: command.value }
      }

      case 'Get': {
        const entries = this.entriesFor(command.keyspace)
        const existing = entries.get(keyStr)
        if (!existing) return { ok: false, error: 'not_found' }
        return { ok: true, existed: true, value: existing.value }
      }
    }
  }

  async flush(): Promise<void> {
    if (this.logFd) await this.logFd.sync()
  }

  async snapshot(): Promise<ShardSnapshot> {
    const entries: Map<string, Map<string, StoredEntry>> = new Map()
    for (const [ks, kv] of this.entries) entries.set(ks, new Map(kv))
    const reservations: Map<string, Map<string, ActiveReservation>> = new Map()
    for (const [ks, rv] of this.reservations) reservations.set(ks, new Map(rv))
    return { shardId: this.shardId, entries, reservations }
  }

  async close(): Promise<void> {
    if (this.logFd) {
      await this.logFd.sync()
      await this.logFd.close()
      this.logFd = null
    }
  }
}

/** Factory for the SHARD_COUNT-sized shard pool used by a bundle's `index/`. */
export async function openShardPool(indexDir: string, count: number): Promise<MemoryShardActor[]> {
  const out: MemoryShardActor[] = []
  for (let i = 0; i < count; i++) {
    out.push(await MemoryShardActor.openPersistent(i, `${indexDir}/shard-${String(i).padStart(2, '0')}.log`))
  }
  return out
}
