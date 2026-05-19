// `prosa index-v2 status` — Lane 3 read-only status command.
//
// Wraps `bundleDerivedStatus(bundleRoot)` from `@c3-oss/prosa-derived-v2`
// and prints the combined Tantivy + SessionBlob snapshot as JSON to
// stdout. Companion to the `index-v2 tantivy` subcommand that will
// land alongside the Tantivy native writer once
// `@oxdev03/node-tantivy-binding` enters the workspace allowBuilds
// list.
//
// The `status` subcommand is pure-read (no native bindings, no
// filesystem mutation) and is safe to ship now: it only consumes
// the read-side library surfaces (`tantivyIndexStatus`,
// `listSessionBlobSummaries`, `listSessionBlobEpochs`). A missing
// bundle directory or missing derived tree collapses to the
// fresh-bundle snapshot (all-empty inventory + `ready_for_read =
// false`), not to a process error — callers can pipe the output
// through `jq` to gate further automation.

import { resolve as resolvePath } from 'node:path'

import {
  ANALYTICS_VIEW_NAMES,
  type AnalyticsViewName,
  TANTIVY_SCHEMA_FIELDS,
  analyticsViewsDescriptor,
  buildCompactManifestV2,
  bundleDerivedStatus,
  currentTantivySchemaFingerprint,
  derivedLayerCapabilities,
  derivedLayerEpochsTouched,
  derivedLayerMaintenanceSummary,
  derivedLayerSnapshot,
  derivedPaths,
  formatTranscriptMarkdownV2,
  formatTranscriptTextV2,
  getSessionBlobSummary,
  listCompactedOutputs,
  listCompactionHistory,
  listProjectionSegments,
  listSessionBlobSummaries,
  listSupersededSegmentsFromManifests,
  loadTranscriptFromBundle,
  planAnalyticsExecution,
  planCompaction,
  planCompactionExecution,
  planGcExecution,
  planSupersededCleanup,
  planTantivyRebuildFromBundle,
  readCompactManifestV2,
  readSessionBlobHeader,
  recommendMaintenanceActions,
  summariseCompactionEffectiveness,
  summariseDerivedLayerFootprint,
  summariseProjectionSegments,
  summariseSupersededSegments,
  verifyAllSessionBlobPacks,
  writeCompactManifestV2,
} from '@c3-oss/prosa-derived-v2'
import { Command } from 'commander'

function parseViewName(raw: string): AnalyticsViewName {
  if ((ANALYTICS_VIEW_NAMES as readonly string[]).includes(raw)) return raw as AnalyticsViewName
  throw new Error(`invalid --view: ${raw} (expected one of: ${ANALYTICS_VIEW_NAMES.join(', ')})`)
}

function parseNonNegativeInteger(label: string, raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || String(n) !== raw) {
    throw new Error(`invalid ${label}: ${raw} (expected non-negative integer)`)
  }
  return n
}

export function indexV2Command(): Command {
  const root = new Command('index-v2').description(
    'Bundle v2 derived-layer index commands (Tantivy + SessionBlob + analytics).',
  )

  root
    .command('maintenance')
    .description(
      'One-call dashboard read: composes status + projection rollup + compaction-plan + persisted-compactions consistency + gc-plan partition into a single JSON snapshot. Use before deciding whether to compile, compact, or GC.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const summary = await derivedLayerMaintenanceSummary(storePath)
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    })

  root
    .command('next-action')
    .description(
      'Prescriptive layer over `maintenance`: returns the ordered list of recommended next actions (resume_compaction → gc_superseded → run_compaction). Returns [] when the bundle is idle. Use to drive operator scripts that branch on the next required step.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const summary = await derivedLayerMaintenanceSummary(storePath)
      const actions = recommendMaintenanceActions(summary)
      process.stdout.write(`${JSON.stringify(actions, null, 2)}\n`)
    })

  root
    .command('status')
    .description('Print the combined Tantivy + SessionBlob status snapshot for a bundle v2 store.')
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const snapshot = await bundleDerivedStatus(storePath)
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    })

  root
    .command('sessions')
    .description(
      'Print the SessionBlob inventory (one summary row per session) for a bundle v2 store. Pass --session-id <id> to filter to a single row (returns [] if the session has no packs).',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .option('--session-id <id>', 'filter to a single session via getSessionBlobSummary')
    .action(async (options: { store: string; sessionId?: string }) => {
      const storePath = resolvePath(options.store)
      if (options.sessionId !== undefined) {
        const summary = await getSessionBlobSummary({ bundleRoot: storePath, sessionId: options.sessionId })
        process.stdout.write(`${JSON.stringify(summary === null ? [] : [summary], null, 2)}\n`)
        return
      }
      const summaries = await listSessionBlobSummaries(storePath)
      process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`)
    })

  root
    .command('epochs')
    .description(
      'Print the sorted set of epoch numbers that have at least one derived artifact (SessionBlob pack or Parquet projection segment) for a bundle v2 store.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const epochs = await derivedLayerEpochsTouched(storePath)
      process.stdout.write(`${JSON.stringify(epochs, null, 2)}\n`)
    })

  root
    .command('analytics-views')
    .description(
      'Print the analytics-view catalog (per-view name + columns + DuckDB SQL body) for the bundle v2 derived layer. Takes no --store; the catalog is content-free.',
    )
    .action(() => {
      const catalog = analyticsViewsDescriptor()
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
    })

  root
    .command('projection-segments')
    .description(
      'Print the list of Parquet projection segments under <store>/epochs/<n>/projection/. Add --summary for the per-entity / per-epoch byte+count rollup instead of the flat listing.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .option('--summary', 'emit the summariseProjectionSegments rollup instead of the flat listing', false)
    .action(async (options: { store: string; summary: boolean }) => {
      const storePath = resolvePath(options.store)
      const result = options.summary
        ? await summariseProjectionSegments(storePath)
        : await listProjectionSegments(storePath)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    })

  root
    .command('analytics-execution-plan')
    .description(
      'Print the ordered DuckDB statement sequence (entity preamble + view body + report query) the runtime executor would issue for the named analytics view against a bundle v2 store.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .requiredOption('--view <name>', `analytics view to materialise (one of: ${ANALYTICS_VIEW_NAMES.join(', ')})`)
    .option(
      '--report-query <sql>',
      'optional custom report query; defaults to `SELECT * FROM <view>;` — passed verbatim (terminate with `;` yourself)',
    )
    .action(async (options: { store: string; view: string; reportQuery?: string }) => {
      const storePath = resolvePath(options.store)
      const view = parseViewName(options.view)
      const plan = planAnalyticsExecution({
        bundleRoot: storePath,
        view,
        reportQuery: options.reportQuery,
      })
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    })

  root
    .command('tantivy-schema')
    .description(
      'Print the Tantivy field schema (name + tokenizer) the Lane 3 writer uses, with the current schema fingerprint. Takes no --store; the schema is content-free. Mirrors `analytics-views` for the Tantivy side.',
    )
    .action(() => {
      const out = {
        fingerprint: currentTantivySchemaFingerprint(),
        fields: TANTIVY_SCHEMA_FIELDS.map((field) => ({ name: field.name, tokenizer: field.tokenizer })),
      }
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    })

  root
    .command('tantivy-rebuild-plan')
    .description(
      'Print the Tantivy rebuild plan (skip/incremental/full + reason + fingerprint) the runtime writer would apply for the given current max search_docs.rowid.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .requiredOption(
      '--current-max-rowid <n>',
      'highest rowid in the current search_docs projection (pass 0 to force full/no_prior_index)',
    )
    .option('--overwrite', 'request a full rebuild regardless of checkpoint state', false)
    .action(async (options: { store: string; currentMaxRowid: string; overwrite: boolean }) => {
      const storePath = resolvePath(options.store)
      const currentMaxRowid = parseNonNegativeInteger('--current-max-rowid', options.currentMaxRowid)
      const result = await planTantivyRebuildFromBundle({
        bundleRoot: storePath,
        currentMaxRowid,
        overwriteRequested: options.overwrite,
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    })

  root
    .command('compaction-plan')
    .description(
      'Print the Parquet compaction plan (which projection segments would be merged per entity type) for a bundle v2 store.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const plan = await planCompaction(storePath)
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    })

  root
    .command('compaction-manifest')
    .description(
      "Print, persist, or read back the `compact.manifest.cbor` shape that records each entity's superseded epoch segments. Default mode generates from the current Parquet compaction plan and prints to stdout. Pass --write to atomically persist the generated manifest to `epochs/compact-<NNNN>/compact.manifest.json` (CQ-093 atomic-rename + parent-fsync + symlink containment). Pass --read --compaction-seq <n> to read back a previously persisted manifest.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .option('--generated-at <iso>', 'ISO-8601 UTC timestamp to embed as `generated_at`; defaults to the current time')
    .option('--write', 'persist the generated manifest to disk via writeCompactManifestV2', false)
    .option('--read', 'read a previously persisted manifest from disk (requires --compaction-seq)', false)
    .option('--compaction-seq <n>', 'compaction sequence to read with --read')
    .action(
      async (options: {
        store: string
        generatedAt?: string
        write: boolean
        read: boolean
        compactionSeq?: string
      }) => {
        if (options.read && options.write) {
          throw new Error('invalid flags: --read and --write are mutually exclusive')
        }
        const storePath = resolvePath(options.store)
        if (options.read) {
          if (options.compactionSeq === undefined) {
            throw new Error('--read requires --compaction-seq <n>')
          }
          const compactionSeq = parseNonNegativeInteger('--compaction-seq', options.compactionSeq)
          const manifest = await readCompactManifestV2(storePath, compactionSeq)
          process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
          return
        }
        const plan = await planCompaction(storePath)
        const generatedAt = options.generatedAt ?? new Date().toISOString()
        const manifest = buildCompactManifestV2({ plan, generatedAt })
        if (options.write) {
          const path = await writeCompactManifestV2(storePath, manifest)
          process.stdout.write(`${JSON.stringify({ manifest, persisted_path: path }, null, 2)}\n`)
          return
        }
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
      },
    )

  root
    .command('compaction-execution-plan')
    .description(
      "Print the ordered DuckDB COPY statement sequence the runtime worker would issue to materialise the Parquet compaction plan for a bundle v2 store. Composes planCompaction + planCompactionExecution so the caller doesn't need both flags.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const plan = await planCompaction(storePath)
      const execution = planCompactionExecution({ bundleRoot: storePath, plan })
      process.stdout.write(`${JSON.stringify(execution, null, 2)}\n`)
    })

  root
    .command('gc-plan')
    .description(
      'Print the GC plan for persisted compactions: every superseded epoch segment tagged with `safe_to_delete: true|false` (true iff the declaring compaction-seq is in a consistent post-merge state). Composes `superseded-segments` + `compacted-outputs` so callers do not need to cross-reference. Pure-read; the planner never deletes anything.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const plan = await planSupersededCleanup(storePath)
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    })

  root
    .command('derived-layout')
    .description(
      'Print the resolved absolute paths for the derived-layer subsystems under `<store>` (root, derived, tantivy, tantivyIndex, tantivyMeta, tantivyCheckpoint, sessionBlob, analytics). Pure path resolution: does not touch the filesystem. Useful for ops scripts that need to know where to look.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const layout = derivedPaths(storePath)
      process.stdout.write(`${JSON.stringify(layout, null, 2)}\n`)
    })

  root
    .command('snapshot')
    .description(
      'One-call bulk read combining maintenance + recommendations + footprint + capabilities into a single JSON object. Internally coherent: recommendations are derived from the same maintenance summary surfaced here. Pure-read. Saves downstream tools (MCP servers, dashboards) the four round-trips.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const snapshot = await derivedLayerSnapshot(storePath)
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    })

  root
    .command('capabilities')
    .description(
      'Print the derived-layer capability snapshot: schema discriminators, compaction fire-reasons + policy thresholds, analytics entity tables + view names, Tantivy schema fingerprint + field list. Content-free, takes no `--store`. Pure introspection — downstream tools / MCP servers / parsers use this to discover what shapes to expect.',
    )
    .action(async () => {
      const caps = derivedLayerCapabilities()
      process.stdout.write(`${JSON.stringify(caps, null, 2)}\n`)
    })

  root
    .command('footprint')
    .description(
      'Print the disk footprint of the derived/ subtree, broken down by subsystem (session-blob, tantivy, analytics, other). Each subsystem reports `{ byte_count, file_count, present }`. Walks `<bundleRoot>/derived/` only; per-epoch projection segments + compaction outputs are reported via `projection-segments --summary` / `compacted-outputs`. Refuses to follow symlinks (CQ-094 parallel).',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const footprint = await summariseDerivedLayerFootprint(storePath)
      process.stdout.write(`${JSON.stringify(footprint, null, 2)}\n`)
    })

  root
    .command('compaction-history')
    .description(
      'Print the per-manifest compaction timeline: one row per persisted `compact.manifest.json` with `compaction_seq`, `generated_at` (verbatim from the manifest), `consistent`, `entity_count`, `superseded_segment_count`, and `manifest_path`. Sorted by `compaction_seq` ascending — also chronological in practice. Pure-read; the audit view that answers "when did each compaction run?".',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const history = await listCompactionHistory(storePath)
      process.stdout.write(`${JSON.stringify(history, null, 2)}\n`)
    })

  root
    .command('compaction-effectiveness')
    .description(
      'Print the per-compaction-seq effectiveness rollup: bytes-in (sum of `superseded[].byte_length` across the manifest) vs bytes-out (sum of on-disk output byte lengths), reduction ratio, and totals across the consistent subset. Inconsistent rows surface in the listing (with `bytes_out: null`) but are excluded from top-level totals. Pure-read; complements `compaction-execution-plan` (how to run it) with the post-hoc "was it worth it?" view.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const summary = await summariseCompactionEffectiveness(storePath)
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    })

  root
    .command('gc-execution-plan')
    .description(
      'Print the GC execution plan — the deterministic ordered list of unlink steps for every safe-to-delete segment. Drops blocked rows; emits one step per safe candidate with `path`, `byte_length`, `epoch`, `entity_type`, `compaction_seq`. Returns `{ empty: true, total_bytes: 0, steps: [] }` when nothing is safe to reclaim. Pure-read; this is the audit/dry-run counterpart to the eventual runtime GC executor.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const plan = await planGcExecution(storePath)
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    })

  root
    .command('compacted-outputs')
    .description(
      'Audit every persisted `compact.manifest.json` against the on-disk presence of the entity output Parquet files it claims. Reports per-compaction-seq `consistent: true|false` so audit/GC workflows can spot mid-merge crashes (manifest present, outputs missing).',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const result = await listCompactedOutputs(storePath)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    })

  root
    .command('superseded-segments')
    .description(
      'Print every superseded epoch segment recorded across persisted `compact.manifest.json` files under <store>/epochs/compact-<NNNN>/. Audit/GC primitive: every row is a file that has already been merged into a compacted output and is safe to remove. Add --summary for the per-entity / per-compaction-seq byte+count rollup.',
    )
    .requiredOption('--store <path>', 'bundle directory')
    .option('--summary', 'emit the summariseSupersededSegments rollup instead of the flat listing', false)
    .action(async (options: { store: string; summary: boolean }) => {
      const storePath = resolvePath(options.store)
      const result = options.summary
        ? await summariseSupersededSegments(storePath)
        : await listSupersededSegmentsFromManifests(storePath)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    })

  root
    .command('verify-packs')
    .description(
      "Verify every SessionBlob pack under <store>/derived/session-blob/. Each pack's verifyPackDigest mismatch lands in `failed[]`; clean packs land in `verified[]`. Exits non-zero when any failure is captured so audit scripts can branch on `$?`.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
      const result = await verifyAllSessionBlobPacks(storePath)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (result.failed.length > 0) process.exit(1)
    })

  root
    .command('transcript-header')
    .description(
      "Print a session's pack header (epoch + pack_digest + per-page aggregates) without decompressing any page. Cheap header-only probe over the latest pack (default) or a specific --epoch.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .requiredOption('--session-id <id>', 'canonical session_id (matches `index-v2 sessions` rows)')
    .option('--epoch <n>', 'specific epoch to read instead of the latest pack', undefined)
    .action(async (options: { store: string; sessionId: string; epoch?: string }) => {
      const storePath = resolvePath(options.store)
      const epoch = options.epoch !== undefined ? parseNonNegativeInteger('--epoch', options.epoch) : undefined
      const header = await readSessionBlobHeader({
        bundleRoot: storePath,
        sessionId: options.sessionId,
        epoch,
      })
      process.stdout.write(`${JSON.stringify(header, null, 2)}\n`)
    })

  root
    .command('transcript')
    .description(
      "Print a session's transcript (epoch + pack_digest + messages) from a bundle v2 store. Defaults to the latest pack; pass --epoch <n> to read a specific historical pack. Output format defaults to JSON; pass --format text|markdown for human-readable rendering with a metadata header. Optional --start-ordinal/--end-ordinal bounds page through long transcripts without decompressing out-of-range pages.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .requiredOption('--session-id <id>', 'canonical session_id (matches `index-v2 sessions` rows)')
    .option('--format <fmt>', 'output format: json|text|markdown (default: json)', 'json')
    .option('--epoch <n>', 'specific epoch to read instead of the latest pack')
    .option(
      '--start-ordinal <n>',
      'inclusive lower bound on message ordinal (skips pages whose ordinal range falls below)',
    )
    .option('--end-ordinal <n>', 'inclusive upper bound on message ordinal')
    .action(
      async (options: {
        store: string
        sessionId: string
        format: string
        epoch?: string
        startOrdinal?: string
        endOrdinal?: string
      }) => {
        // CQ-105: validate `--format` synchronously before any bundle read so
        // invalid formats fail with `invalid --format` regardless of whether the
        // requested session exists or the store is reachable.
        if (options.format !== 'json' && options.format !== 'text' && options.format !== 'markdown') {
          throw new Error(`invalid --format: ${options.format} (expected json|text|markdown)`)
        }
        const epoch = options.epoch !== undefined ? parseNonNegativeInteger('--epoch', options.epoch) : undefined
        const startOrdinal =
          options.startOrdinal !== undefined
            ? parseNonNegativeInteger('--start-ordinal', options.startOrdinal)
            : undefined
        const endOrdinal =
          options.endOrdinal !== undefined ? parseNonNegativeInteger('--end-ordinal', options.endOrdinal) : undefined
        if (startOrdinal !== undefined && endOrdinal !== undefined && startOrdinal > endOrdinal) {
          throw new Error(`invalid range: --start-ordinal (${startOrdinal}) > --end-ordinal (${endOrdinal})`)
        }
        const storePath = resolvePath(options.store)
        const range = startOrdinal !== undefined || endOrdinal !== undefined ? { startOrdinal, endOrdinal } : undefined
        const transcript = await loadTranscriptFromBundle({
          bundleRoot: storePath,
          sessionId: options.sessionId,
          epoch,
          range,
        })
        if (options.format === 'text') {
          process.stdout.write(formatTranscriptTextV2(transcript, { includeHeader: true }))
          return
        }
        if (options.format === 'markdown') {
          process.stdout.write(formatTranscriptMarkdownV2(transcript, { includeHeader: true }))
          return
        }
        process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`)
      },
    )

  return root
}
