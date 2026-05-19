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
  analyticsViewsDescriptor,
  buildCompactManifestV2,
  bundleDerivedStatus,
  derivedLayerEpochsTouched,
  formatTranscriptMarkdownV2,
  formatTranscriptTextV2,
  getSessionBlobSummary,
  listProjectionSegments,
  listSessionBlobSummaries,
  loadTranscriptFromBundle,
  planAnalyticsExecution,
  planCompaction,
  planCompactionExecution,
  planTantivyRebuildFromBundle,
  readSessionBlobHeader,
  summariseProjectionSegments,
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
      "Print the `compact.manifest.cbor` shape the runtime worker would persist for the current Parquet compaction plan. Records each entity's superseded epoch segments so audit/GC workflows can recover the pre-compaction layout. Returns an error when the plan is empty.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .option('--generated-at <iso>', 'ISO-8601 UTC timestamp to embed as `generated_at`; defaults to the current time')
    .action(async (options: { store: string; generatedAt?: string }) => {
      const storePath = resolvePath(options.store)
      const plan = await planCompaction(storePath)
      const generatedAt = options.generatedAt ?? new Date().toISOString()
      const manifest = buildCompactManifestV2({ plan, generatedAt })
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    })

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
      "Print a session's latest-epoch transcript (epoch + pack_digest + messages) from a bundle v2 store. Default format is JSON; pass --format text for a plain-text render with a metadata header.",
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
