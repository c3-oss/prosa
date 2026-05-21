// `runCompileImports` — the Lane 2 orchestrator.
//
// Flow per provider:
//   1. Discover every source file the provider owns.
//   2. Cheap-identify each file → derive `logicalKey` and `unit_id`.
//   3. For each file, `Reserve` the logical key on the owning shard.
//      Only the winner does the full parse / projection. Losers attach
//      their source_file_id as a candidate (the provider's merge layer
//      consults the candidate list in `parseAndProject`).
//   4. Run the provider's `parseAndProject` on the winning files.
//   5. Stream the unit's raw_source payloads through the raw-source
//      pack writer pool.
//   6. Commit the reservation.
//
// After every provider has run:
//   7. `GraphResolver.resolveLateBindings` fills `parent_session_id` /
//      `parent_resolution` and produces any `SessionFixupV2` rows.
//   8. Emit one projection segment per non-empty entity type and
//      register it on the EpochHandle.
//   9. `sealEpoch` performs the durability + FK closure checks and
//      atomically advances `head.json` to the new epoch.
//
// All paths through the orchestrator share one EpochHandle so the
// epoch is the atomic unit of compile progress.

import { randomUUID } from 'node:crypto'

import type {
  ArtifactV2,
  CanonicalEntityType,
  CborValue,
  ContentBlockV2,
  EdgeV2,
  EventV2,
  MessageV2,
  ProjectV2,
  RawRecordV2,
  RawSourceLeafInput,
  SearchDocV2,
  SessionFixupV2,
  SessionV2,
  SourceFileV2,
  ToolCallV2,
  ToolResultV2,
  TurnV2,
} from '@c3-oss/prosa-types-v2'
import { canonicalTimestamp } from '@c3-oss/prosa-types-v2'

import type {
  Bundle,
  CasPackEmission,
  DurableSegmentRef,
  EpochHandle,
  RawSourcePackEmission,
  ShardActor,
} from '@c3-oss/prosa-bundle-v2'
import {
  CasPackWriterPool,
  RawSourcePackWriterPool,
  beginEpoch,
  sealEpoch,
  writeProjectionSegment,
} from '@c3-oss/prosa-bundle-v2'

import { type PriorEpochSessionInventory, resolveLateBindings } from './graph-resolver.js'
import type { CanonicalProjectionDraft, DiscoveredSourceFile, LogicalImportUnit, Provider } from './types.js'
import { PROJECTION_ENTITY_ORDER } from './types.js'

export type ReserveResult =
  | { kind: 'won'; unit_id: string }
  | { kind: 'lost'; unit_id: string }
  | { kind: 'serialization_error' }

/**
 * Reserve-then-parse helper around the shard actor. Sessions are the
 * dominant keyspace; importers that need to reserve other kinds
 * (artifacts, projects, etc.) call `bundle.shard.apply({ op: 'Reserve' })`
 * directly.
 */
export async function reserveSession(args: {
  shard: ShardActor
  key: Uint8Array
  ttlMs: number
  ownerId: string
  sourceTool: string
  unitId: string
}): Promise<ReserveResult> {
  const response = await args.shard.apply({
    op: 'Reserve',
    keyspace: 'session',
    key: args.key,
    ttlMs: args.ttlMs,
    owner: { ownerId: args.ownerId, sourceTool: args.sourceTool },
  })
  if (!response.ok) {
    if (response.error === 'reserved_by_other') return { kind: 'lost', unit_id: args.unitId }
    if (response.error === 'serialization_error') return { kind: 'serialization_error' }
    // not_found / reservation_expired during Reserve are impossible by
    // the actor contract — fall through as serialization_error.
    return { kind: 'serialization_error' }
  }
  return { kind: 'won', unit_id: args.unitId }
}

export type RunCompileImportsOptions = {
  bundle: Bundle
  /** Map of provider id → discovery root + Provider implementation. */
  providers: Array<{ provider: Provider; root: string }>
  /** Optional shard actor for Reserve flow; when omitted, every file is treated as a winner. */
  shard?: ShardActor
  /** Override the createdAt for deterministic tests. */
  createdAt?: string
  /** Reservation TTL in ms (default 60_000). */
  reserveTtlMs?: number
  /** Worker identifier used for the reservation owner field. */
  ownerId?: string
  /** Prior-epoch inventory for GraphResolver (Lane 1 has none). */
  priorEpochs?: PriorEpochSessionInventory | null
}

export type RunCompileImportsResult = {
  sealedEpoch: number
  perProvider: Array<{
    source_tool: string
    discovered: number
    won: number
    lost: number
    units: number
    counts: ReturnType<EpochHandle['computeCounts']>
  }>
  fixups: SessionFixupV2[]
}

export async function runCompileImports(options: RunCompileImportsOptions): Promise<RunCompileImportsResult> {
  const bundle = options.bundle
  const createdAt = options.createdAt ?? canonicalTimestamp(new Date().toISOString())
  const ttlMs = options.reserveTtlMs ?? 60_000
  const ownerId = options.ownerId ?? `worker-${randomUUID()}`

  const handle = await beginEpoch(bundle, { createdAt })
  // Per-epoch raw-source pack writer pool, scoped to this bundle.
  const rawPool = new RawSourcePackWriterPool({
    rawSourcesDir: `${bundle.paths.root}/raw_sources`,
    createdAt: () => createdAt,
  })
  // Per-epoch CAS pool. Importers stage every `*_object_id` reference
  // via `LogicalImportUnit.cas_object_candidates`; the orchestrator
  // drives `appendObject` for each entry below so the bytes land in a
  // registered `cas_object_pack` segment before sealEpoch enforces
  // FK closure on `OBJECT_ID_FIELDS`.
  const casPool = new CasPackWriterPool({
    casDir: `${bundle.paths.root}/cas`,
    createdAt: () => createdAt,
  })

  const perProvider: RunCompileImportsResult['perProvider'] = []
  for (const { provider, root } of options.providers) {
    const discovered = await provider.discover(root)
    let won = 0
    let lost = 0
    const units: LogicalImportUnit[] = []
    for (const file of discovered) {
      const id = await provider.cheapIdentify(file)
      let reserve: ReserveResult = { kind: 'won', unit_id: id.unit_id }
      if (options.shard) {
        reserve = await reserveSession({
          shard: options.shard,
          key: id.logicalKey,
          ttlMs,
          ownerId,
          sourceTool: provider.source_tool,
          unitId: id.unit_id,
        })
      }
      if (reserve.kind === 'lost') {
        lost++
        continue
      }
      if (reserve.kind === 'serialization_error') {
        throw new Error(`runCompileImports: shard serialization_error reserving ${file.path}`)
      }
      won++
      const result = await provider.parseAndProject({
        files: [file],
        identification: id,
        createdAt,
      })
      units.push(result.unit)
    }

    // Stream raw bytes through the raw-source pool.
    for (const unit of units) {
      for (const sourceFileId of unit.source_file_ids) {
        const payload = unit.raw_source_payloads.get(sourceFileId)
        if (!payload) continue
        await rawPool.appendSourceFile({
          source_file_id: sourceFileId,
          source_tool: unit.source_tool,
          path: discoveredPathFor(discovered, sourceFileId) ?? `unknown://${sourceFileId}`,
          file_kind: discoveredKindFor(discovered, sourceFileId) ?? 'unknown',
          mtime_ns: null,
          bytes: payload,
        })
      }
    }

    // Merge each unit's projection into the EpochHandle's rows.
    for (const unit of units) {
      mergeProjectionIntoHandle(handle, unit.projection)
      for (const leaf of unit.raw_source_leaves) handle.putRawSource(leaf)
      // Stage every CAS-tagged column the importer wrote into a row.
      // The pool re-derives `object_id` from `blake3(bytes)` so we
      // assert it matches the importer's pre-computed identity; any
      // drift would surface as a sealEpoch FK closure failure later,
      // and catching it here keeps the message attributable to the
      // staging importer.
      for (const candidate of unit.cas_object_candidates) {
        const append = await casPool.appendObject({
          bytes: candidate.bytes,
          ...(candidate.mime_type !== undefined ? { mime_type: candidate.mime_type } : {}),
        })
        if (append.object_id !== candidate.object_id) {
          throw new Error(
            `cas candidate object_id mismatch: importer staged ${candidate.object_id}, pool admitted ${append.object_id}`,
          )
        }
      }
    }

    perProvider.push({
      source_tool: provider.source_tool,
      discovered: discovered.length,
      won,
      lost,
      units: units.length,
      counts: handle.computeCounts(),
    })
  }

  // Flush raw-source pool + register packs.
  const rawEmissions: RawSourcePackEmission[] = await rawPool.flushAll()
  for (const e of rawEmissions) {
    handle.registerSegment({
      kind: 'raw_source_pack',
      path: e.packPath,
      digest: e.packDigest,
      byteLength: e.built.bytes.length,
    })
  }

  // Flush CAS pool + register every cas_object_pack segment so
  // sealEpoch's FK closure check finds every `*_object_id` reference
  // the importers staged. The pool already accumulates mid-flight
  // rollovers internally (small + large), so `flushAll()` returns
  // every pack on disk in one shot.
  const casEmissions: CasPackEmission[] = await casPool.flushAll()
  for (const e of casEmissions) {
    handle.registerSegment({
      kind: 'cas_object_pack',
      path: e.packPath,
      digest: e.packDigest,
      byteLength: e.built.bytes.length,
    })
  }

  // Backfill the pack-derived columns on every staged source_file row.
  // Providers cannot know the final pack_digest / stored_offset /
  // stored_length until the raw-source pool flushes; CQ-037 demands
  // equivalence between source_file rows and verified pack entries, so
  // the orchestrator owns the rewrite.
  const packEntriesById = new Map<
    string,
    {
      pack_digest: string
      stored_offset: number
      stored_length: number
      compression: 'zstd' | 'none'
      uncompressed_size: number
      content_hash: string
      object_id: string
      stored_hash: string
    }
  >()
  for (const e of rawEmissions) {
    for (const entry of e.built.header.entries) {
      packEntriesById.set(entry.source_file_id, {
        pack_digest: e.packDigest,
        stored_offset: entry.stored_offset,
        stored_length: entry.stored_length,
        compression: entry.compression,
        uncompressed_size: entry.uncompressed_size,
        content_hash: entry.content_hash,
        object_id: entry.object_id,
        stored_hash: entry.stored_hash,
      })
    }
  }
  const stagedSourceFiles = (handle.rowsByEntity().source_file ?? []) as Array<Record<string, CborValue>>
  for (const row of stagedSourceFiles) {
    const sfid = row.source_file_id as string | undefined
    if (!sfid) continue
    const entry = packEntriesById.get(sfid)
    if (!entry) continue
    row.pack_digest = entry.pack_digest
    row.stored_offset = entry.stored_offset
    row.stored_length = entry.stored_length
    row.compression = entry.compression
    row.size_bytes = entry.uncompressed_size
    row.content_hash = entry.content_hash
    row.object_id = entry.object_id
    handle.putRow('source_file', sfid, row)
  }

  // GraphResolver: parent_session_id back-fill + cross-epoch fixups.
  const rowsByEntity = handle.rowsByEntity()
  const sessions = (rowsByEntity.session ?? []) as unknown as SessionV2[]
  const edges = (rowsByEntity.edge ?? []) as unknown as EdgeV2[]
  const { resolved, fixups } = resolveLateBindings({
    sessions,
    edges,
    epoch: handle.epoch,
    createdAt,
    priorEpochs: options.priorEpochs ?? null,
    generateFixupId: () => `fix_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  })
  // Replace session rows with resolved ones (parent_session_id +
  // parent_resolution populated).
  for (const s of resolved) handle.putRow('session', s.session_id, s as unknown as Record<string, CborValue>)

  // Emit projection segments per entity and register them.
  for (const entity of PROJECTION_ENTITY_ORDER) {
    const rows = (handle.rowsByEntity() as Record<CanonicalEntityType, Record<string, CborValue>[]>)[entity]
    if (!rows || rows.length === 0) continue
    const r = await writeProjectionSegment(entity, rows, { outDir: handle.tmpDir })
    const ref: DurableSegmentRef = r.ref
    handle.registerSegment(ref)
  }

  // Seal.
  const sealed = await sealEpoch(handle)
  return {
    sealedEpoch: sealed.epoch,
    perProvider,
    fixups,
  }
}

function discoveredPathFor(files: readonly DiscoveredSourceFile[], id: string): string | null {
  for (const f of files) {
    if (f.source_file_id === id) return f.path
  }
  return null
}

function discoveredKindFor(files: readonly DiscoveredSourceFile[], id: string): string | null {
  for (const f of files) {
    if (f.source_file_id === id) return f.file_kind
  }
  return null
}

function mergeProjectionIntoHandle(handle: EpochHandle, p: CanonicalProjectionDraft): void {
  for (const row of p.projects) handle.putRow('project', row.project_id, row as unknown as Record<string, CborValue>)
  for (const row of p.sessions) handle.putRow('session', row.session_id, row as unknown as Record<string, CborValue>)
  for (const row of p.turns) handle.putRow('turn', row.turn_id, row as unknown as Record<string, CborValue>)
  for (const row of p.events) handle.putRow('event', row.event_id, row as unknown as Record<string, CborValue>)
  for (const row of p.messages) handle.putRow('message', row.message_id, row as unknown as Record<string, CborValue>)
  for (const row of p.content_blocks)
    handle.putRow('content_block', row.block_id, row as unknown as Record<string, CborValue>)
  for (const row of p.tool_calls)
    handle.putRow('tool_call', row.tool_call_id, row as unknown as Record<string, CborValue>)
  for (const row of p.tool_results)
    handle.putRow('tool_result', row.tool_result_id, row as unknown as Record<string, CborValue>)
  for (const row of p.artifacts) handle.putRow('artifact', row.artifact_id, row as unknown as Record<string, CborValue>)
  for (const row of p.edges) handle.putRow('edge', row.edge_id, row as unknown as Record<string, CborValue>)
  for (const row of p.search_docs) handle.putRow('search_doc', row.doc_id, row as unknown as Record<string, CborValue>)
  for (const row of p.raw_records)
    handle.putRow('raw_record', row.raw_record_id, row as unknown as Record<string, CborValue>)
  for (const row of p.source_files)
    handle.putRow('source_file', row.source_file_id, row as unknown as Record<string, CborValue>)
}

// Re-exported for tests + consumer convenience.
export type {
  ArtifactV2,
  ContentBlockV2,
  EdgeV2,
  EventV2,
  MessageV2,
  ProjectV2,
  RawRecordV2,
  RawSourceLeafInput,
  SearchDocV2,
  SessionFixupV2,
  SessionV2,
  SourceFileV2,
  ToolCallV2,
  ToolResultV2,
  TurnV2,
}
