# Lane 9 — Migration

## Goal

Ship the one-shot migration tool that converts a v1 bundle to a v2 bundle locally, and the remote re-projection job for users who purged their local bundle after promoting to v1. Migration re-projects from preserved raw bytes through the v2 importer pipeline — no compat shims, no dual-write.

## Depends on

- Lane 2 (Importers) complete — the v2 importer is the re-projection engine.
- Lane 5 (Sync protocol) complete — remote re-projection writes through the v2 promotion flow.

## Deliverables

- New CLI command `prosa migrate-v2` with subcommands `bundle` (local) and `tenant` (remote).
- New API endpoint `POST /v2/migrate/tenant` (admin-tenant procedure) for the remote re-projection job.
- Migration log table on the server: `legacy_receipt_archive`.
- E2E test scenarios covering local and remote migration.

## Tasks

1. **`prosa migrate-v2 bundle`.** Local migration:
   - Open the v1 bundle read-only.
   - Read `source_files` table; for each row, locate the preserved bytes (`raw/sources/<blake3>.zst` in v1).
   - Feed the bytes back through the v2 importer pipeline (Lane 2). Idempotency keys ensure no duplicate writes.
   - Produce a fresh v2 bundle at the target path with one large epoch containing all reconstructed data.
   - Validate counts: source files, raw records, sessions, objects, search docs must match v1 reads.
   - Atomically rename: old `~/.prosa` → `~/.prosa-v0-archive-<timestamp>`, new `~/.prosa-v2-tmp` → `~/.prosa`.
2. **Migration count validation.** Before atomic rename, query both bundles and compare:
   - `source_files` count (must equal).
   - `raw_records` count (must equal).
   - `sessions` count (must equal).
   - `objects` count (v2 may be ≤ v1 if some objects were redundant; flag if v2 > v1).
   - `search_docs` count (allow small variance for derived re-computation).
3. **Migration progress reporting.** `prosa migrate-v2 bundle --verbose` reports per-phase timing: discovery, parse + CAS stage, projection assembly, seal. JSON output mode for automation.
4. **Fallback: recompile from provider history.** If raw bytes are unrecoverable (e.g. corrupted v1 archive), fall back to walking the original provider directories (`~/.codex`, `~/.claude`, etc.) as if running a fresh `compile-all-v2`. Document this as a one-time disaster recovery path, not a compat mode.
5. **`prosa migrate-v2 tenant`.** Remote re-projection (admin-only):
   - Server endpoint scans the tenant's v1 catalog rows: `source_files`, `raw_records`, references to `objects`.
   - For each source file, fetch the preserved bytes from S3 (v1 stored at `objects/blake3/<aa>/<bb>/<hash>.zst`).
   - Feed through the server-side v2 importer (a stripped-down version of Lane 2 that produces canonical projection rows directly, without going through a local bundle).
   - Upsert into v2 `projection_*` tables; insert receipts; update `remote_authority_v2`.
   - On completion, archive v1 receipts to `legacy_receipt_archive`.
6. **`legacy_receipt_archive` consumption.** Archived v1 receipts remain queryable for audit but cannot authorize v2 reads. The verified-projection gate (Lane 6) only checks `remote_authority_v2`.
7. **Migration policy doc.** Document: if local migration cannot reproduce a sane v2 bundle (count mismatch, raw bytes missing), the user is instructed to either (a) run remote `migrate-v2 tenant` if they had promoted, or (b) recompile from provider directories from scratch.

## Concrete types and schemas

### Local migration flow

```ts
// apps/cli/src/cli/v2/migrate/bundle.ts
export async function migrateBundle(options: MigrateBundleOptions): Promise<MigrationResult> {
  const oldPath = options.oldPath        // e.g. ~/.prosa
  const newPath = options.newPath        // e.g. ~/.prosa-v2-tmp

  // Open v1 bundle read-only.
  const v1 = await openV1Bundle(oldPath, { readOnly: true })

  // Initialize v2 bundle.
  const v2 = await initBundleV2(newPath, { storeId: v1.storeId })

  // Discover all source files from v1.
  const v1SourceFiles = await v1.db.prepare(`
    SELECT source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id, workspace_hint
      FROM source_files
  `).all()

  const counts = emptyCounts()

  // Reconstruct each source file's bytes and feed through v2 importer.
  for await (const batch of chunked(v1SourceFiles, 8)) {
    await Promise.all(batch.map(async (sf) => {
      const bytes = await readPreservedSourceBytes(v1, sf.object_id)
      // Write bytes to a temp file so the v2 importer can re-discover via its provider walk.
      const tempPath = path.join(v2.path, 'migration-temp', sf.path)
      await fs.mkdir(path.dirname(tempPath), { recursive: true })
      await fs.writeFile(tempPath, bytes)

      const importer = getProviderImporter(sf.source_tool)
      await importer.importFile(v2, tempPath, { sourceFileId: sf.source_file_id })
      await fs.rm(tempPath)
    }))
  }

  // GraphResolver runs across the whole epoch.
  await runGraphResolver(v2)

  // Seal the migration epoch.
  await sealEpoch(v2)

  // Validate counts.
  const validation = await validateMigrationCounts(v1, v2)
  if (!validation.ok) {
    throw new MigrationError(`Count mismatch: ${JSON.stringify(validation.diff)}`)
  }

  // Atomic rename.
  const archivePath = `${oldPath}-v0-archive-${Date.now()}`
  await fs.rename(oldPath, archivePath)
  await fs.rename(newPath, oldPath)

  return {
    migratedAt: new Date().toISOString(),
    archivedAt: archivePath,
    counts: validation.v2Counts,
    durationMs: Date.now() - startMs,
  }
}
```

### Validation

```ts
// apps/cli/src/cli/v2/migrate/validate.ts
export async function validateMigrationCounts(
  v1: V1Bundle,
  v2: BundleV2,
): Promise<MigrationValidation> {
  const v1Counts = {
    sourceFiles: countTable(v1.db, 'source_files'),
    rawRecords: countTable(v1.db, 'raw_records'),
    sessions: countTable(v1.db, 'sessions'),
    objects: countTable(v1.db, 'objects'),
    searchDocs: countTable(v1.db, 'search_docs'),
  }
  const v2Counts = await v2.snapshotCounts()

  const diff = {
    sourceFiles: v2Counts.sourceFiles - v1Counts.sourceFiles,
    rawRecords: v2Counts.rawRecords - v1Counts.rawRecords,
    sessions: v2Counts.sessions - v1Counts.sessions,
    objects: v2Counts.objects - v1Counts.objects,
    searchDocs: v2Counts.searchDocs - v1Counts.searchDocs,
  }

  // Strict equality on the load-bearing counts.
  const ok =
    diff.sourceFiles === 0 &&
    diff.rawRecords === 0 &&
    diff.sessions === 0 &&
    diff.objects <= 0 &&         // v2 may consolidate; not more
    Math.abs(diff.searchDocs) < 0.01 * v1Counts.searchDocs   // allow ≤1% variance

  return { ok, v1Counts, v2Counts, diff }
}
```

### Remote re-projection

```ts
// apps/api/src/v2/migrate/tenant.ts (admin endpoint)
export async function migrateTenant(
  ctx: AdminV2RequestContext,
  input: MigrateTenantInput,
): Promise<MigrateTenantResponse> {
  // 1. Load v1 catalog for tenant.
  const v1SourceFiles = await ctx.db.query<V1SourceFileRow>(`
    SELECT * FROM legacy_v1_source_files WHERE tenant_id = $1
  `, [ctx.tenantId])

  // 2. For each source file, fetch preserved bytes from S3 (v1 layout).
  for (const sf of v1SourceFiles.rows) {
    const bytes = await ctx.objectStore.get(v1StorageKey(sf.object_id))
    if (!bytes) {
      // Raw bytes missing; cannot reproject this file.
      await recordMigrationGap(ctx, sf)
      continue
    }
    // 3. Run v2 importer in server-mode (writes directly to projection_* tables).
    await serverSideV2Importer(ctx, sf.source_tool, bytes, sf)
  }

  // 4. Build a single synthetic "migration receipt" covering the whole tenant.
  const receipt = await synthesizeMigrationReceipt(ctx)

  // 5. Archive v1 receipts.
  await archiveV1Receipts(ctx)

  return { migratedAt: new Date().toISOString(), receiptId: receipt.payload.receiptId, gaps: collectedGaps }
}
```

## Tests

| File | Asserts |
|---|---|
| `apps/cli/test/v2/migrate/bundle-roundtrip.test.ts` | Take a v1 fixture bundle; migrate to v2; counts match; reads against v2 return the same sessions/messages/tool calls as v1. |
| `apps/cli/test/v2/migrate/bundle-corruption-fallback.test.ts` | One raw_source bytes file is corrupted; migration tool falls back to provider-directory recompile for that source file; reports gap. |
| `apps/cli/test/v2/migrate/bundle-atomic-rename.test.ts` | Migration fails mid-flight (simulated `SIGKILL`); v1 bundle untouched at original path; `~/.prosa-v2-tmp` cleaned on next run. |
| `apps/cli/test/v2/migrate/bundle-count-validation.test.ts` | Inject a missing raw_record; validator catches the mismatch and aborts before rename. |
| `apps/api/test/v2/migrate/tenant-roundtrip.test.ts` | Server-side re-projection of a v1 tenant catalog produces v2 projection_* rows matching the local migration output. |
| `apps/api/test/v2/migrate/legacy-receipts-archived.test.ts` | After remote migration, old v1 receipts moved to `legacy_receipt_archive`; v2 reads reject any attempt to use them as authority. |
| `apps/cli/test/v2/migrate/timing.test.ts` | Migration of a 1.4 GB v1 fixture completes in 45–120 s on reference hardware. |

## Gate

The lane is complete when:

1. All test files above pass.
2. `prosa migrate-v2 bundle --old ~/.prosa --new ~/.prosa-v2-tmp` on the reference 1.4 GB fixture completes successfully; reads against the new bundle return the same sessions/messages/tool calls as the v1 bundle did pre-migration.
3. Server-side `POST /v2/migrate/tenant` successfully migrates a synthetic tenant from v1 to v2; v2 reads return the same data.
4. Atomic-rename safety verified: `SIGKILL` mid-migration leaves v1 intact.
5. Migration of 1.4 GB fixture completes in 45–120 s (matches Lane 0 target).

## Risks

| Risk | Mitigation |
|---|---|
| Raw bytes lost or corrupted in v1 archive | Validation phase catches and surfaces the gap; fallback to provider-directory recompile is documented; manual ops intervention if both fail. |
| Server-side migration runs longer than transaction safety allows | Migration runs **outside** the seal transaction; only the final authority swap is in a TX. Migration can be paused/resumed via `migration_progress` state. |
| User runs migration on a partially-promoted bundle | Detected at validation (v1 promotion receipts archived but local bundle was purged); migration tool prompts user to confirm and uses provider-directory recompile. |
| Disk space pressure during migration (v1 + v2 + v0-archive coexist) | Migration tool checks free space ≥ 3× v1 bundle size before starting; aborts with explicit message otherwise. |
| Count mismatch from legitimate v2 schema changes (e.g. consolidated objects) | Strict equality only on `sourceFiles`, `rawRecords`, `sessions`. `objects` allows ≤, `searchDocs` allows ±1%. Documented in `MIGRATION.md`. |

## Unblocks

Lane 10 (`11-lane-10-cutover.md`) — final cutover step requires migration tooling to be operational for users who haven't promoted yet.
