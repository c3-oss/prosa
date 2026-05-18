import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MemoryShardActor } from '../../src/shard/memory-actor.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function k(s: string): Uint8Array {
  return enc.encode(s)
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-shard-'))
}

describe('MemoryShardActor — command semantics', () => {
  it('PutIfAbsent is atomic on a first write', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    const r1 = await a.apply({ op: 'PutIfAbsent', keyspace: 'session', key: k('ses_001'), value: k('payload-1') })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.existed).toBe(false)
    const r2 = await a.apply({ op: 'PutIfAbsent', keyspace: 'session', key: k('ses_001'), value: k('payload-2') })
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.existed).toBe(true)
      expect(dec.decode(r2.value as Uint8Array)).toBe('payload-1')
    }
    await a.close()
  })

  it('Reserve gives exclusive ownership; second Reserve from a different owner is rejected', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    const r1 = await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 60_000,
      owner: { ownerId: 'worker-A' },
    })
    expect(r1.ok).toBe(true)
    const r2 = await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 60_000,
      owner: { ownerId: 'worker-B' },
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe('reserved_by_other')
    await a.close()
  })

  it('Reserve with the same owner extends TTL', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    let t = 1000
    a.setClock(() => t)
    await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 1000,
      owner: { ownerId: 'worker-A' },
    })
    t = 1500
    const r2 = await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 1000,
      owner: { ownerId: 'worker-A' },
    })
    expect(r2.ok).toBe(true)
    t = 2400 // > original 1000+1000 but < extended 1500+1000
    const r3 = await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 1000,
      owner: { ownerId: 'worker-B' },
    })
    expect(r3.ok).toBe(false)
    await a.close()
  })

  it('Reservation TTL expiry releases the key', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    let t = 1000
    a.setClock(() => t)
    await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 500,
      owner: { ownerId: 'worker-A' },
    })
    t = 2000 // past expiry
    const r2 = await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 500,
      owner: { ownerId: 'worker-B' },
    })
    expect(r2.ok).toBe(true)
    await a.close()
  })

  it('CommitReservation requires an active reservation by the same owner', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    // No reservation yet
    const r0 = await a.apply({
      op: 'CommitReservation',
      keyspace: 'session',
      key: k('ses_001'),
      owner: { ownerId: 'worker-A' },
      value: k('v'),
    })
    expect(r0.ok).toBe(false)
    if (!r0.ok) expect(r0.error).toBe('not_found')

    await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 60_000,
      owner: { ownerId: 'worker-A' },
    })
    const r1 = await a.apply({
      op: 'CommitReservation',
      keyspace: 'session',
      key: k('ses_001'),
      owner: { ownerId: 'worker-B' },
      value: k('v'),
    })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('reserved_by_other')

    const r2 = await a.apply({
      op: 'CommitReservation',
      keyspace: 'session',
      key: k('ses_001'),
      owner: { ownerId: 'worker-A' },
      value: k('v'),
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.existed).toBe(false)

    // After commit, Get returns the value.
    const r3 = await a.apply({ op: 'Get', keyspace: 'session', key: k('ses_001') })
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(dec.decode(r3.value as Uint8Array)).toBe('v')

    await a.close()
  })

  it('CommitReservation rejects when the reservation has expired', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    let t = 1000
    a.setClock(() => t)
    await a.apply({
      op: 'Reserve',
      keyspace: 'session',
      key: k('ses_001'),
      ttlMs: 500,
      owner: { ownerId: 'worker-A' },
    })
    t = 2000
    const r = await a.apply({
      op: 'CommitReservation',
      keyspace: 'session',
      key: k('ses_001'),
      owner: { ownerId: 'worker-A' },
      value: k('v'),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('reservation_expired')
    await a.close()
  })

  it('persists state across reopen via append log', async () => {
    const dir = await tmp()
    const path = join(dir, 'shard.log')
    const a = await MemoryShardActor.openPersistent(0, path)
    await a.apply({ op: 'PutIfAbsent', keyspace: 'session', key: k('ses_001'), value: k('persistent') })
    await a.close()

    const b = await MemoryShardActor.openPersistent(0, path)
    const r = await b.apply({ op: 'Get', keyspace: 'session', key: k('ses_001') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(dec.decode(r.value as Uint8Array)).toBe('persistent')
    await b.close()

    const raw = await readFile(path, 'utf8')
    expect(raw.split('\n').filter(Boolean).length).toBe(1)
  })

  it('Get returns not_found for unknown keys', async () => {
    const a = MemoryShardActor.memoryOnly(0)
    const r = await a.apply({ op: 'Get', keyspace: 'session', key: k('missing') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('not_found')
    await a.close()
  })
})
