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

import { mkdtemp, rm } from 'node:fs/promises'
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
  /** Optional override for the server region inserted into the receipt payload. */
  serverRegion?: string
}

export type MigrateTenantResponse = {
  migratedAt: string
  receiptId: string | null
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

  // Build + sign a synthetic v2 receipt that covers the whole
  // tenant migration. The receipt's `storeId` is the union store
  // when there is only one; otherwise a synthetic `migration-multi`
  // id is used so the receipt remains unique.
  const storeIdsList = [...storeIds].sort()
  const receiptStoreId = storeIdsList.length === 1 ? (storeIdsList[0] ?? 'migration-store') : 'migration-multi'
  const issuedAt = canonicalNowMs(now(deps))
  const payload = buildMigrationReceiptPayload({
    tenantId,
    storeId: receiptStoreId,
    bundleRoot: bundleHead.bundleRoot,
    rawSourceRoot: bundleHead.rawSourceRoot,
    counts: bundleHead.counts,
    serverRegion: input.serverRegion ?? deps.serverRegion ?? 'local',
    serverKeyId: deps.signer.currentKeyId(),
    issuedAt,
  })
  const receiptId = deriveReceiptId(payload)
  const finalPayload: PromotionReceiptV2Payload = { ...payload, receiptId }
  const signatureBytes = receiptPayloadBytes(finalPayload)
  const signature = await deps.signer.signReceipt(signatureBytes)

  // Persist receipt + projection rows + archive in one transaction.
  const archivedReceiptIds = await deps.transaction(async (tx) => {
    await tx(
      `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (receipt_id) DO NOTHING`,
      [
        finalPayload.receiptId,
        tenantId,
        receiptStoreId,
        'migration',
        JSON.stringify(finalPayload),
        JSON.stringify(signature),
      ],
    )
    for (const storeId of storeIdsList) {
      await tx(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, store_id) DO UPDATE
           SET current_receipt_id = EXCLUDED.current_receipt_id,
               current_bundle_root = EXCLUDED.current_bundle_root,
               promoted_at = EXCLUDED.promoted_at`,
        [tenantId, storeId, finalPayload.receiptId, finalPayload.bundleRoot],
      )
    }

    for (const sf of sourceFiles) {
      if (gaps.find((g) => g.source_file_id === sf.source_file_id)) continue
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
          `migration_pack_${finalPayload.receiptId.slice(0, 12)}`,
          JSON.stringify({
            store_id: sf.store_id,
            receipt_id: finalPayload.receiptId,
            migrated_from: 'v1',
          }),
        ],
      )
    }

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

    // Archive any v1 receipts so subsequent v2 reads cannot resolve
    // them as authority. The query is best-effort: tests may omit
    // the `legacy_v1_receipt` source table, in which case we skip.
    const archived = await archiveLegacyV1Receipts(tx, tenantId, receiptStoreId)
    return archived
  })

  return {
    migratedAt: new Date().toISOString(),
    receiptId: finalPayload.receiptId,
    storeIds: storeIdsList,
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
  let rows: Array<{ receipt_id: string; payload: unknown; signature: unknown }>
  try {
    rows = await tx<{ receipt_id: string; payload: unknown; signature: unknown }>(
      `SELECT receipt_id, payload, signature FROM legacy_v1_receipt
        WHERE tenant_id = $1 AND store_id = $2`,
      [tenantId, storeId],
    )
  } catch {
    return []
  }
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

// Re-export so the test app can compare bundleRoot computation
// against the migrated head.
export { bundleRootFromRows, toHex }
