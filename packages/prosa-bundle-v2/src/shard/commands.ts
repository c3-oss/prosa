// Shard actor command vocabulary (lane doc §"Shard actor command
// vocabulary"). Each shard owns a slice of the keyspace and serializes
// writes; consumers issue commands through a typed interface.

export type Keyspace = 'source_file' | 'raw_record' | 'object' | 'session' | 'project' | 'edge' | 'reservation'

export type ReserveOwner = {
  /** Importer worker id (or generic producer id) holding the reservation. */
  ownerId: string
  /** Provider tag, useful for auditing why a reservation exists. */
  sourceTool?: string
}

export type ShardCommand =
  | { op: 'PutIfAbsent'; keyspace: Keyspace; key: Uint8Array; value: Uint8Array }
  | {
      op: 'Reserve'
      keyspace: Keyspace
      key: Uint8Array
      ttlMs: number
      owner: ReserveOwner
    }
  | {
      op: 'CommitReservation'
      keyspace: Keyspace
      key: Uint8Array
      owner: ReserveOwner
      value: Uint8Array
    }
  | { op: 'Get'; keyspace: Keyspace; key: Uint8Array }

export type ShardErrorCode = 'reserved_by_other' | 'reservation_expired' | 'not_found' | 'serialization_error'

export type ShardResponse =
  | { ok: true; existed: boolean; value: Uint8Array | null }
  | { ok: false; error: ShardErrorCode }

/**
 * Public interface for a shard actor. The in-memory and persistent
 * implementations both satisfy this contract.
 */
export interface ShardActor {
  apply(command: ShardCommand): Promise<ShardResponse>
  /** Drop any in-memory state and persist queued changes (best effort). */
  flush(): Promise<void>
  /** Snapshot the entire shard's state for cold-rebuild + debugging. */
  snapshot(): Promise<ShardSnapshot>
  close(): Promise<void>
}

export type StoredEntry = {
  value: Uint8Array
  /** epoch when the value was first committed; null when not yet sealed. */
  committedEpoch: number | null
}

export type ActiveReservation = {
  owner: ReserveOwner
  expiresAt: number
}

export type ShardSnapshot = {
  shardId: number
  entries: ReadonlyMap<string, ReadonlyMap<string, StoredEntry>>
  reservations: ReadonlyMap<string, ReadonlyMap<string, ActiveReservation>>
}
