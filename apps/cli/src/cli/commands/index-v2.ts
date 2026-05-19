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
  analyticsViewsDescriptor,
  bundleDerivedStatus,
  derivedLayerEpochsTouched,
  listProjectionSegments,
  listSessionBlobSummaries,
  loadTranscriptFromBundle,
  planCompaction,
  planTantivyRebuildFromBundle,
  summariseProjectionSegments,
} from '@c3-oss/prosa-derived-v2'
import { Command } from 'commander'

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
    .description('Print the SessionBlob inventory (one summary row per session) for a bundle v2 store.')
    .requiredOption('--store <path>', 'bundle directory')
    .action(async (options: { store: string }) => {
      const storePath = resolvePath(options.store)
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
    .command('transcript')
    .description(
      "Print a session's latest-epoch transcript (epoch + pack_digest + messages) as JSON from a bundle v2 store.",
    )
    .requiredOption('--store <path>', 'bundle directory')
    .requiredOption('--session-id <id>', 'canonical session_id (matches `index-v2 sessions` rows)')
    .action(async (options: { store: string; sessionId: string }) => {
      const storePath = resolvePath(options.store)
      const transcript = await loadTranscriptFromBundle({
        bundleRoot: storePath,
        sessionId: options.sessionId,
      })
      process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`)
    })

  return root
}
