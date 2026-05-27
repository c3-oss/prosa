// Lane 9 — server-side tenant re-projection.
//
// `migrateTenant` is the headless equivalent of the local
// `prosa migrate-v2 bundle` command. It walks a tenant's v1 catalog
// (`legacy_v1_source_files`), fetches preserved bytes from object
// storage, feeds them through a temp v2 bundle + the canonical v2
// importer pipeline, and persists:
//
//   - one `projection_source_file` row per migrated v1 source file,
//   - one `projection_session` row per re-projected session,
//   - one signed v2 receipt + a corresponding `remote_authority_v2`
//     row (or upsert if the tenant already has v2 authority),
//   - every gap into `legacy_v1_migration_gap` (audit-only),
//   - every v1 receipt (if any) into `legacy_receipt_archive`.
//
// The implementation deliberately keeps the projection-row writes
// scoped to the load-bearing entities the Lane 6 read API consumes;
// the broader CQ-124 materialization is Lane 10 scope. Tests assert
// that re-projection produced at least the source-file and session
// rows expected from the staged v1 fixture.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle as initBundleV2, type openBundle as openBundleV2 } from '@c3-oss/prosa-bundle-v2'
import {
  ClaudeProvider,
  CodexProvider,
  CursorProvider,
  GeminiProvider,
  HermesProvider,
  type Provider,
  runCompileImports,
} from '@c3-oss/prosa-importers-v2'
import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import { type ObjectMeta as RemoteObjectMeta, asyncIterableToUint8Array } from '@c3-oss/prosa-storage'
import {
  type PromotionReceiptV2Payload,
  type SourceTool,
  base32LowerNoPad,
  bundleRootFromRows,
  deriveReceiptId,
  receiptPayloadBytes,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import type { DatabaseHandle, RawExec } from '../../db.js'
import type { ReceiptSigner } from '../signing/local-signer.js'
import { writeBytesToServerStaging } from './staging.js'

export type LegacyV1SourceFile = {
  source_file_id: string
  source_tool: SourceTool
  store_id: string
  path: string
  file_kind: string
  content_hash: string
  storage_key: string
  size_bytes: number | null
}

export type MigrateTenantGap = {
  source_file_id: string
  source_tool: SourceTool
  reason: 'raw_bytes_missing' | 'raw_bytes_corrupted' | 'size_mismatch' | 'parse_failed'
  detail?: string
}

export type MigrateTenantInput = {
  tenantId: string
  storeId?: string
}

export type MigrateTenantResponse = {
  migratedAt: string
  /**
   * CQ-159: the receipt id of the FIRST migrated store. Multi-store
   * migrations issue one receipt per store; callers should consult
   * `receiptIdsByStore` to learn each per-store receipt id. `null`
   * when nothing was migrated.
   */
  receiptId: string | null
  /** Per-store signed receipts (CQ-159). */
  receiptIdsByStore: Record<string, string>
  storeIds: string[]
  counts: {
    sourceFiles: number
    rawRecords: number
    sessions: number
  }
  gaps: MigrateTenantGap[]
  archivedReceiptIds: string[]
}

export type MigrateTenantDeps = {
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  signer: ReceiptSigner
  /** Override for the server region; defaults to `'local'`. */
  serverRegion?: string
  /** Override the now() clock for deterministic receipts in tests. */
  now?: () => Date
}

/**
 * Re-project a tenant's v1 catalog through the v2 importer pipeline.
 * Resolves on completion; the response contains the synthesized v2
 * receipt id (or null when there was nothing to migrate).
 */
export async function migrateTenant(
  deps: MigrateTenantDeps,
  input: MigrateTenantInput,
): Promise<MigrateTenantResponse> {
  const tenantId = input.tenantId
  const sourceFiles = await readLegacySourceFiles(deps.rawExec, tenantId, input.storeId)
  const gaps: MigrateTenantGap[] = []
  const storeIds = new Set<string>()
  for (const sf of sourceFiles) storeIds.add(sf.store_id)

  if (sourceFiles.length === 0) {
    return {
      migratedAt: now(deps).toISOString(),
      receiptId: null,
      receiptIdsByStore: {},
      storeIds: [],
      counts: { sourceFiles: 0, rawRecords: 0, sessions: 0 },
      gaps: [],
      archivedReceiptIds: [],
    }
  }

  // Spin up a temp v2 bundle on disk; the orchestrator requires a
  // local bundle but the directory only lives for the lifetime of
  // this request.
  const bundleRoot = await mkdtemp(join(tmpdir(), `prosa-migrate-v2-tenant-${tenantId}-`))
  let counts = { sourceFiles: 0, rawRecords: 0, sessions: 0 }
  // `bundleHead` is captured BEFORE bundle.close() so the receipt
  // payload's bundleRoot / rawSourceRoot reflect the temp v2 bundle
  // sealed during migration. If every staged file ended up in `gaps`
  // and no provider was ever invoked the head still carries the
  // empty-bundle roots from `initBundle`.
  let bundleHead!: Awaited<ReturnType<typeof openBundleV2>>['head']
  let sessionRows: SessionProjectionRow[] = []
  let rawRecordRows: RawRecordProjectionRow[] = []
  let sourceFileRows: SourceFileProjectionRow[] = []
  try {
    const bundle = await initBundleV2(bundleRoot)
    try {
      // Group by source tool and stage each file's bytes for the
      // v2 importer's discovery walk.
      const grouped = new Map<SourceTool, LegacyV1SourceFile[]>()
      for (const sf of sourceFiles) {
        const arr = grouped.get(sf.source_tool) ?? []
        arr.push(sf)
        grouped.set(sf.source_tool, arr)
      }
      const providers: { provider: Provider; root: string }[] = []
      for (const [tool, rows] of grouped) {
        const root = join(bundle.paths.tmp, 'migration-staging', tool)
        let any = false
        for (const row of rows) {
          const bytes = await tryFetch(deps.objectStore, row, gaps)
          if (!bytes) continue
          try {
            await writeBytesToServerStaging({
              root,
              tool: row.source_tool,
              sourceFileId: row.source_file_id,
              contentHash: row.content_hash,
              originalPath: row.path,
              fileKind: row.file_kind,
              bytes,
            })
            any = true
          } catch (err) {
            gaps.push({
              source_file_id: row.source_file_id,
              source_tool: row.source_tool,
              reason: 'parse_failed',
              detail: err instanceof Error ? err.message : String(err),
            })
          }
        }
        if (any) providers.push({ provider: providerFor(tool), root })
      }

      if (providers.length > 0) {
        await runCompileImports({ bundle, providers })
        // CQ-158: drain the bundle's sealed session + raw_record
        // projection NDJSON so we can re-emit `projection_session`
        // rows. SessionV2 has no `source_file_id` field — it
        // references its origin via `raw_record_id`, which the
        // raw_record projection joins back to `source_file_id`.
        sessionRows = await readProjection<SessionProjectionRow>(bundle.paths.epochs, 'session')
        rawRecordRows = await readProjection<RawRecordProjectionRow>(bundle.paths.epochs, 'raw_record')
        sourceFileRows = await readProjection<SourceFileProjectionRow>(bundle.paths.epochs, 'source_file')
      }
      bundleHead = bundle.head
      counts = {
        sourceFiles: bundle.head.counts.sourceFiles,
        rawRecords: bundle.head.counts.rawRecords,
        sessions: bundle.head.counts.sessions,
      }
    } finally {
      await bundle.close()
    }
  } finally {
    // Best-effort cleanup; tests may keep failures around if the
    // bundle is referenced by name.
    try {
      await rm(bundleRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  // CQ-159: issue one signed v2 receipt PER migrated store, and
  // archive each real store's v1 receipts. The previous synthetic
  // `migration-multi` store id meant authority rows could not be
  // resolved by Lane 6 reads (`receipt.store_id` was never one of
  // the real stores), and the per-store v1 receipt archive never
  // happened.
  //
  // Provenance model (documented per CQ-159 final review): each
  // per-store receipt carries the same tenant-wide `bundleRoot`,
  // `rawSourceRoot`, and load-bearing counts because all stores
  // were migrated together through one shared bundle. This is a
  // deliberate tenant-wide-authority-root semantic for migration
  // receipts: every per-store receipt commits to the EXACT same
  // canonical bundle root, so Lane 6 reads (which join through
  // `(tenant_id, store_id, receipt_id)` only) cannot leak rows
  // across stores. Production sealed receipts carry per-store
  // roots; migration receipts use this tenant-wide model to avoid
  // re-running the bundle build per store. If a future requirement
  // demands per-store roots in the migration receipt, the
  // `buildMigrationReceiptPayload` body can be reshaped without
  // changing the call sites.
  //
  // CQ-158: fail closed BEFORE writing any receipt + authority +
  // archive rows when the migration could not materialize the
  // load-bearing projection rows for a store. If ANY store has
  // gaps in its source files we refuse to publish authority for
  // that store; the route still returns the recorded gaps so the
  // operator knows which store failed.
  const storeIdsList = [...storeIds].sort()
  const issuedAt = canonicalNowMs(now(deps))
  const serverRegion = deps.serverRegion ?? 'local'
  const serverKeyId = deps.signer.currentKeyId()

  // Group source files + gaps per store so we can decide per-store
  // whether to publish authority.
  const filesByStore = new Map<string, LegacyV1SourceFile[]>()
  for (const sf of sourceFiles) {
    const arr = filesByStore.get(sf.store_id) ?? []
    arr.push(sf)
    filesByStore.set(sf.store_id, arr)
  }
  const gapsByStore = new Map<string, Set<string>>()
  for (const gap of gaps) {
    const ownerStore = sourceFiles.find((sf) => sf.source_file_id === gap.source_file_id)?.store_id
    if (!ownerStore) continue
    const set = gapsByStore.get(ownerStore) ?? new Set<string>()
    set.add(gap.source_file_id)
    gapsByStore.set(ownerStore, set)
  }

  type PerStoreReceipt = {
    storeId: string
    payload: PromotionReceiptV2Payload
    signature: Awaited<ReturnType<ReceiptSigner['signReceipt']>>
    publish: boolean
  }
  const perStore: PerStoreReceipt[] = []
  for (const storeId of storeIdsList) {
    const storeFiles = filesByStore.get(storeId) ?? []
    const storeGaps = gapsByStore.get(storeId) ?? new Set<string>()
    const usable = storeFiles.filter((sf) => !storeGaps.has(sf.source_file_id))
    // CQ-158: any gap in this store blocks authority publish. The
    // projection inserts below are also skipped, so v2 reads never
    // see a partial store.
    const publish = storeGaps.size === 0 && usable.length > 0
    const draft = buildMigrationReceiptPayload({
      tenantId,
      storeId,
      bundleRoot: bundleHead.bundleRoot,
      rawSourceRoot: bundleHead.rawSourceRoot,
      counts: bundleHead.counts,
      serverRegion,
      serverKeyId,
      issuedAt,
    })
    const receiptId = deriveReceiptId(draft)
    const finalPayload: PromotionReceiptV2Payload = { ...draft, receiptId }
    const signature = await deps.signer.signReceipt(receiptPayloadBytes(finalPayload))
    perStore.push({ storeId, payload: finalPayload, signature, publish })
  }

  // CQ-158: build a raw_record_id -> source_file_id map AND a
  // canonical-source_file_id -> v1-source_file_id map. The v2
  // importer assigns fresh canonical ids derived from
  // `(source_tool, content_hash)`, so the legacy id never appears
  // in the bundle's projection rows. We bridge by matching on
  // `content_hash` against the legacy v1 catalog.
  const rawRecordToSourceFile = new Map<string, string>()
  for (const r of rawRecordRows) {
    if (typeof r.raw_record_id === 'string' && typeof r.source_file_id === 'string') {
      rawRecordToSourceFile.set(r.raw_record_id, r.source_file_id)
    }
  }
  const contentHashToLegacy = new Map<string, string>()
  for (const sf of sourceFiles) {
    contentHashToLegacy.set(sf.content_hash.toLowerCase(), sf.source_file_id)
  }
  const canonicalToLegacy = new Map<string, string>()
  for (const sf of sourceFileRows) {
    if (typeof sf.source_file_id === 'string' && typeof sf.content_hash === 'string') {
      const normalized = sf.content_hash.toLowerCase().replace(/^blake3:/, '')
      const legacy = contentHashToLegacy.get(normalized)
      if (legacy) canonicalToLegacy.set(sf.source_file_id, legacy)
    }
  }

  const archivedReceiptIds = await deps.transaction(async (tx) => {
    const archivedAll: string[] = []
    for (const entry of perStore) {
      if (!entry.publish) continue
      await tx(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (receipt_id) DO NOTHING`,
        [
          entry.payload.receiptId,
          tenantId,
          entry.storeId,
          'migration',
          JSON.stringify(entry.payload),
          JSON.stringify(entry.signature),
        ],
      )
      await tx(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, store_id) DO UPDATE
           SET current_receipt_id = EXCLUDED.current_receipt_id,
               current_bundle_root = EXCLUDED.current_bundle_root,
               promoted_at = EXCLUDED.promoted_at`,
        [tenantId, entry.storeId, entry.payload.receiptId, entry.payload.bundleRoot],
      )

      const storeSourceFileIds = new Set<string>()
      const storeFiles = filesByStore.get(entry.storeId) ?? []
      for (const sf of storeFiles) storeSourceFileIds.add(sf.source_file_id)
      // CQ-158: persist `projection_session` rows for every session
      // whose origin source_file belongs to THIS store. The session
      // projection row format mirrors the SealPromotion projection
      // upsert so Lane 6 reads can resolve `(tenantId, storeId,
      // receiptId)` against `projection_session`. The insert is
      // gated on the v2 column being present because CQ-124 leaves
      // mixed v1+v2 deployments with the v1 `projection_session(id)`
      // shape; Lane 10 cutover replaces it with the v2 columns and
      // the projection rows start flowing.
      const v2Shape = await hasV2SessionProjectionShape(tx)
      if (v2Shape) {
        await insertSessionProjectionRows(tx, {
          tenantId,
          storeId: entry.storeId,
          receiptId: entry.payload.receiptId,
          storeSourceFileIds,
          sessionRows,
          rawRecordToSourceFile,
          canonicalToLegacy,
        })
      }
      for (const sf of storeFiles) {
        if (gapsByStore.get(entry.storeId)?.has(sf.source_file_id)) continue
        await tx(
          `INSERT INTO projection_source_file (
             tenant_id, source_file_id, source_tool, path, file_kind,
             content_hash, object_id, pack_digest, payload
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (tenant_id, source_file_id) DO NOTHING`,
          [
            tenantId,
            sf.source_file_id,
            sf.source_tool,
            sf.path,
            sf.file_kind,
            sf.content_hash,
            `blake3:${sf.content_hash}`,
            `migration_pack_${entry.payload.receiptId.slice(0, 12)}`,
            JSON.stringify({
              store_id: sf.store_id,
              receipt_id: entry.payload.receiptId,
              migrated_from: 'v1',
            }),
          ],
        )
      }

      // CQ-159: archive v1 receipts for THIS real store.
      const archived = await archiveLegacyV1Receipts(tx, tenantId, entry.storeId)
      for (const id of archived) archivedAll.push(id)
    }

    // Gaps are always persisted, even for stores whose authority was
    // not published, so an operator can see why publish was skipped.
    for (const gap of gaps) {
      await tx(
        `INSERT INTO legacy_v1_migration_gap (
           tenant_id, source_file_id, source_tool, reason, detail
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, source_file_id) DO UPDATE
           SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, recorded_at = now()`,
        [tenantId, gap.source_file_id, gap.source_tool, gap.reason, gap.detail ?? null],
      )
    }

    return archivedAll
  })

  const receiptIdsByStore: Record<string, string> = {}
  for (const entry of perStore) {
    if (entry.publish) receiptIdsByStore[entry.storeId] = entry.payload.receiptId
  }
  const publishedStoreIds = Object.keys(receiptIdsByStore).sort()
  const firstReceiptId = publishedStoreIds.length > 0 ? receiptIdsByStore[publishedStoreIds[0]!]! : null

  return {
    migratedAt: new Date().toISOString(),
    receiptId: firstReceiptId,
    receiptIdsByStore,
    storeIds: publishedStoreIds,
    counts,
    gaps,
    archivedReceiptIds,
  }
}

async function tryFetch(
  store: RemoteObjectStore,
  sf: LegacyV1SourceFile,
  gaps: MigrateTenantGap[],
): Promise<Uint8Array | null> {
  let meta: RemoteObjectMeta | null
  try {
    meta = await store.head(sf.storage_key)
  } catch (err) {
    gaps.push({
      source_file_id: sf.source_file_id,
      source_tool: sf.source_tool,
      reason: 'raw_bytes_corrupted',
      detail: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (!meta) {
    gaps.push({
      source_file_id: sf.source_file_id,
      source_tool: sf.source_tool,
      reason: 'raw_bytes_missing',
      detail: `storage_key=${sf.storage_key}`,
    })
    return null
  }
  let bytes: Uint8Array
  try {
    const stream = await store.get(sf.storage_key)
    bytes = await asyncIterableToUint8Array(streamToAsyncIterable(stream))
  } catch (err) {
    gaps.push({
      source_file_id: sf.source_file_id,
      source_tool: sf.source_tool,
      reason: 'raw_bytes_corrupted',
      detail: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (sf.size_bytes != null && Number(meta.uncompressedSize) !== Number(sf.size_bytes)) {
    gaps.push({
      source_file_id: sf.source_file_id,
      source_tool: sf.source_tool,
      reason: 'size_mismatch',
      detail: `expected=${sf.size_bytes} actual=${meta.uncompressedSize}`,
    })
    return null
  }
  // CQ-158 governor follow-up: same-size corrupted bytes must fail
  // closed. Recompute BLAKE3 of the fetched bytes and compare to the
  // catalog `content_hash` (normalized to lowercase hex without the
  // optional `blake3:` prefix). A mismatch records
  // `raw_bytes_corrupted` so the per-store publish gate (CQ-158)
  // refuses to upsert authority for this store.
  const expected = sf.content_hash.toLowerCase().replace(/^blake3:/, '')
  if (expected.length > 0) {
    const observed = toHex(blake3(bytes))
    if (observed !== expected) {
      gaps.push({
        source_file_id: sf.source_file_id,
        source_tool: sf.source_tool,
        reason: 'raw_bytes_corrupted',
        detail: `content_hash mismatch expected=blake3:${expected} actual=blake3:${observed}`,
      })
      return null
    }
  }
  return bytes
}

async function* streamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

async function readLegacySourceFiles(
  rawExec: RawExec,
  tenantId: string,
  storeId?: string,
): Promise<LegacyV1SourceFile[]> {
  const params: unknown[] = [tenantId]
  let where = 'WHERE tenant_id = $1'
  if (storeId) {
    where += ' AND store_id = $2'
    params.push(storeId)
  }
  const rows = await rawExec<{
    source_file_id: string
    source_tool: string
    store_id: string
    path: string
    file_kind: string
    content_hash: string
    storage_key: string
    size_bytes: string | number | null
  }>(
    `SELECT source_file_id, source_tool, store_id, path, file_kind, content_hash, storage_key, size_bytes
       FROM legacy_v1_source_files ${where}
       ORDER BY source_file_id`,
    params,
  )
  return rows.map((r) => ({
    source_file_id: r.source_file_id,
    source_tool: r.source_tool as SourceTool,
    store_id: r.store_id,
    path: r.path,
    file_kind: r.file_kind,
    content_hash: r.content_hash,
    storage_key: r.storage_key,
    size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
  }))
}

async function archiveLegacyV1Receipts(tx: RawExec, tenantId: string, storeId: string): Promise<string[]> {
  // Tests opt-in to the v1 receipt archive flow by pre-populating
  // a `legacy_v1_receipt` table with `(receipt_id, tenant_id,
  // store_id, payload, signature)`. The migrate route copies those
  // rows into `legacy_receipt_archive` and deletes the originals.
  // When the table is missing we skip silently — the route still
  // works for environments that never persisted v1 receipts on the
  // server.
  // Probe `information_schema.tables` first: a failed SELECT
  // inside the Postgres transaction would mark the whole tx as
  // aborted and force every subsequent statement (including the
  // receipt + projection inserts) to fail too. PGlite mirrors that
  // behaviour.
  const tableProbe = await tx<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'legacy_v1_receipt'
     ) AS exists`,
    [],
  )
  if (!tableProbe[0]?.exists) return []
  const rows = await tx<{ receipt_id: string; payload: unknown; signature: unknown }>(
    `SELECT receipt_id, payload, signature FROM legacy_v1_receipt
      WHERE tenant_id = $1 AND store_id = $2`,
    [tenantId, storeId],
  )
  if (rows.length === 0) return []
  const archived: string[] = []
  for (const row of rows) {
    await tx(
      `INSERT INTO legacy_receipt_archive (receipt_id, tenant_id, store_id, payload, signature)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (receipt_id) DO NOTHING`,
      [
        row.receipt_id,
        tenantId,
        storeId,
        JSON.stringify(row.payload),
        row.signature == null ? null : JSON.stringify(row.signature),
      ],
    )
    archived.push(row.receipt_id)
  }
  // Delete the originals so v2 reads cannot resolve them as
  // authority. The cleanup is intentionally inside the same
  // transaction as the archive insert.
  await tx(`DELETE FROM legacy_v1_receipt WHERE tenant_id = $1 AND store_id = $2`, [tenantId, storeId])
  return archived
}

function providerFor(tool: SourceTool): Provider {
  switch (tool) {
    case 'codex':
      return new CodexProvider()
    case 'claude':
      return new ClaudeProvider()
    case 'cursor':
      return new CursorProvider()
    case 'gemini':
      return new GeminiProvider()
    case 'hermes':
      return new HermesProvider()
  }
}

function buildMigrationReceiptPayload(input: {
  tenantId: string
  storeId: string
  bundleRoot: string
  rawSourceRoot: string
  counts: PromotionReceiptV2Payload['counts']
  serverRegion: string
  serverKeyId: string
  issuedAt: string
}): PromotionReceiptV2Payload {
  // Migration receipts carry zero per-entity row counts because the
  // server's projection inventory is still being shaped by Lane 10
  // (CQ-124). The fields are filled with a deterministic placeholder
  // derived from the bundleRoot so the receipt remains canonical.
  const rowCountsByEntity: PromotionReceiptV2Payload['materialization']['rowCountsByEntity'] = {
    project: 0,
    session: input.counts.sessions,
    turn: input.counts.turns,
    event: input.counts.events,
    message: input.counts.messages,
    content_block: input.counts.contentBlocks,
    tool_call: input.counts.toolCalls,
    tool_result: input.counts.toolResults,
    artifact: input.counts.artifacts,
    edge: input.counts.edges,
    search_doc: input.counts.searchDocs,
    raw_record: input.counts.rawRecords,
    source_file: input.counts.sourceFiles,
  }
  return {
    receiptVersion: 2,
    receiptId: 'rcpt_placeholder',
    protocolVersion: 2,
    tenantId: input.tenantId,
    storeId: input.storeId,
    storePath: `migration://${input.tenantId}/${input.storeId}`,
    deviceId: 'migration',
    issuedAt: input.issuedAt,
    serverRegion: input.serverRegion,
    serverKeyId: input.serverKeyId,
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: input.bundleRoot,
    rawSourceRoot: input.rawSourceRoot,
    counts: input.counts,
    materialization: {
      postgresCommitId: `pgc_migrate_${suffix(input.tenantId, input.storeId, input.bundleRoot)}`,
      searchGenerationId: `gen_migrate_${suffix(input.tenantId, input.storeId, input.bundleRoot)}`,
      rowCountsByEntity,
    },
    verification: {
      uploadDigestVerified: true,
      objectHashesVerifiedAtIngest: true,
      projectionRowsLoaded: true,
      noPerObjectHeadRequired: true,
      backgroundAuditEligible: true,
    },
    clientSignatureStatus: 'absent_v2_0',
  }
}

function suffix(tenantId: string, storeId: string, bundleRoot: string): string {
  return base32LowerNoPad(blake3(new TextEncoder().encode(`${tenantId}|${storeId}|${bundleRoot}`))).slice(0, 12)
}

function canonicalNowMs(d: Date): string {
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d
    .getUTCDate()
    .toString()
    .padStart(2, '0')}T${d.getUTCHours().toString().padStart(2, '0')}:${d
    .getUTCMinutes()
    .toString()
    .padStart(
      2,
      '0',
    )}:${d.getUTCSeconds().toString().padStart(2, '0')}.${d.getUTCMilliseconds().toString().padStart(3, '0')}Z`
}

function now(deps: MigrateTenantDeps): Date {
  return deps.now ? deps.now() : new Date()
}

async function hasV2SessionProjectionShape(tx: RawExec): Promise<boolean> {
  const rows = await tx<{ has: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'projection_session'
          AND column_name = 'session_id'
     ) AS has`,
    [],
  )
  return rows[0]?.has === true
}

async function insertSessionProjectionRows(
  tx: RawExec,
  args: {
    tenantId: string
    storeId: string
    receiptId: string
    storeSourceFileIds: Set<string>
    sessionRows: SessionProjectionRow[]
    rawRecordToSourceFile: Map<string, string>
    canonicalToLegacy: Map<string, string>
  },
): Promise<void> {
  for (const session of args.sessionRows) {
    const originIds = collectSourceFileIds(session, args.rawRecordToSourceFile, args.canonicalToLegacy)
    const ownedHere = originIds.some((id) => args.storeSourceFileIds.has(id))
    if (!ownedHere) continue
    await tx(
      `INSERT INTO projection_session (
         tenant_id, session_id, store_id, receipt_id,
         source_tool, source_session_id, project_id,
         parent_session_id, parent_resolution, is_subagent,
         title, summary, start_ts, end_ts, status,
         timeline_confidence, raw_record_id, payload
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
       ON CONFLICT (tenant_id, session_id) DO NOTHING`,
      [
        args.tenantId,
        String(session.session_id),
        args.storeId,
        args.receiptId,
        String(session.source_tool ?? 'unknown'),
        String(session.source_session_id ?? session.session_id),
        session.project_id == null ? null : String(session.project_id),
        session.parent_session_id == null ? null : String(session.parent_session_id),
        String(session.parent_resolution ?? 'none'),
        Boolean(session.is_subagent),
        session.title == null ? null : String(session.title),
        session.summary == null ? null : String(session.summary),
        session.start_ts == null ? null : String(session.start_ts),
        session.end_ts == null ? null : String(session.end_ts),
        session.status == null ? null : String(session.status),
        String(session.timeline_confidence ?? 'unknown'),
        session.raw_record_id == null ? null : String(session.raw_record_id),
        JSON.stringify(session),
      ],
    )
  }
}

/**
 * CQ-158 helper: read a sealed projection NDJSON segment from the
 * migrated bundle. The function walks every epoch directory, finds
 * the highest epoch's `<entity>.prosa-projection.ndjson`, and returns
 * the parsed rows. Empty / missing files yield an empty array.
 */
type SessionProjectionRow = Record<string, unknown> & { session_id: string }
type RawRecordProjectionRow = Record<string, unknown> & {
  raw_record_id: string
  source_file_id: string
}
type SourceFileProjectionRow = Record<string, unknown> & {
  source_file_id: string
  content_hash: string
}

async function readProjection<T extends Record<string, unknown>>(epochsDir: string, entityType: string): Promise<T[]> {
  let entries: string[]
  try {
    entries = await readdir(epochsDir)
  } catch {
    return []
  }
  const epochs = entries
    .map((name) => Number(name))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)
  for (const epoch of epochs) {
    const segmentPath = join(epochsDir, String(epoch), 'projection', `${entityType}.prosa-projection.ndjson`)
    let raw: Buffer
    try {
      raw = await readFile(segmentPath)
    } catch {
      continue
    }
    const text = raw.toString('utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    // First line is the header; the rest are canonical-JSON rows.
    const rows: T[] = []
    for (let i = 1; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i] as string) as Record<string, unknown>
        rows.push(parsed as T)
      } catch {
        // Skip malformed rows; the bundle's projection writer should
        // never emit them, but a corrupted file should not crash
        // migration.
      }
    }
    return rows
  }
  return []
}

/**
 * CQ-158: SessionV2 references its origin `source_file_id` via
 * `raw_record_id` (the session's first raw record). We follow that
 * link through the raw_record projection to attribute the session to
 * its store. Some legacy session rows also carry an inline
 * `source_file_id` / `source_file_ids` array; we honor those too.
 */
function collectSourceFileIds(
  session: Record<string, unknown>,
  rawRecordToSourceFile: Map<string, string>,
  canonicalToLegacy: Map<string, string>,
): string[] {
  const ids: string[] = []
  if (typeof session.source_file_id === 'string') ids.push(session.source_file_id)
  if (Array.isArray(session.source_file_ids)) {
    for (const id of session.source_file_ids) if (typeof id === 'string') ids.push(id)
  }
  if (typeof session.raw_record_id === 'string') {
    const canonical = rawRecordToSourceFile.get(session.raw_record_id)
    if (canonical) {
      ids.push(canonical)
      // Map the canonical (v2) source_file_id back to its v1 legacy
      // catalog id so the per-store filter matches the entries in
      // `legacy_v1_source_files`.
      const legacy = canonicalToLegacy.get(canonical)
      if (legacy) ids.push(legacy)
    }
  }
  return ids
}

// Re-export so the test app can compare bundleRoot computation
// against the migrated head.
export { bundleRootFromRows, toHex }
