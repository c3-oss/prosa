// Tantivy native runtime writer.
//
// Glues the pure rebuild planner (`planTantivyRebuildFromBundle`) to
// the actual `@oxdev03/node-tantivy-binding` writer + checkpoint
// persistence. The writer is the runtime executor referenced by
// `docs/rearch-2/04-lane-3-derived-layer.md` task #1/#2: it ports the
// v1 `rebuildTantivyIndex` shape to bundle v2 while keeping the
// planner / probe / checkpoint store pure.
//
// Inputs:
//
//   - `bundleRoot`: absolute path to the bundle. Determines the index
//     directory, checkpoint path, and the CQ-094/CQ-096 containment
//     surfaces.
//   - `currentMaxRowid` + `sourceDocCount`: caller-derived stats from
//     the v2 search_docs projection. The writer treats these as
//     authoritative; the caller is responsible for matching them to
//     the rows yielded by `loadRows`.
//   - `loadRows(plan)`: row producer the caller wires to its projection
//     reader. Receives the planned mode so the caller can filter for
//     `incremental` (`rowid > lastIndexedRowid`) versus `full`
//     (everything). Keeping the producer outside the writer keeps the
//     runtime testable with in-memory rows and lets the eventual
//     Parquet reader land independently.
//   - `overwriteRequested`: forwarded to the planner; mirrors
//     `prosa index-v2 tantivy --overwrite`.
//   - `heapBytes` / `numThreads`: native writer tuning. Defaults
//     match the lean-profile Lane 3 doc (300 MiB / 4 threads); tests
//     downscale to the Tantivy minimum (3 MiB per thread).
//
// Output: a discriminated `RuntimeResult`. `skipped` returns the
// already-good checkpoint; `rebuilt` returns the updated checkpoint;
// `failed` returns the failure-marked checkpoint plus the error
// message so the caller can surface it to the CLI/MCP layer without
// re-deriving it.
//
// Side effects, in order: (1) when the plan is `full` the index dir
// is cleared via `clearTantivyIndexDir` (CQ-094/CQ-096 hardened);
// (2) the native writer rebuilds/appends documents; (3) the writer
// commits + drains merging threads so the directory lock is released
// before the next call; (4) `writeIndexCheckpoint` records the new
// `IndexCheckpointV2` atomically (CQ-093).
//
// Crash-recovery: a process killed mid-rebuild leaves an unrecoverable
// index dir (no fresh `meta.json` until commit). The next run plans
// `full / index_dir_invalid` and starts over. The writer therefore
// does NOT pre-write a `status: 'building'` checkpoint — the planner
// already handles "no/garbage index" via `full`, and skipping the
// extra write avoids an fsync round-trip on every call.

import { writeIndexCheckpoint } from './checkpoint-store.js'
import { clearTantivyIndexDir, tantivyIndexDir } from './index-dir.js'
import { planTantivyRebuildFromBundle } from './plan-bundle.js'
import {
  type IndexCheckpointV2,
  type RebuildPlan,
  checkpointAfterFailure,
  checkpointAfterRebuild,
} from './rebuild-plan.js'
import {
  type SearchDocInputV2,
  TANTIVY_SCHEMA_FIELDS,
  currentTantivySchemaFingerprint,
  toTantivyFieldMap,
} from './schema.js'

/** Total target heap memory for the native writer, in bytes.
 *  Mirrors the lean-profile Lane 3 doc (300 MiB). */
const DEFAULT_HEAP_BYTES = 300 * 1024 * 1024
/** Default writer thread count, matching the Lane 3 doc. */
const DEFAULT_NUM_THREADS = 4

/** Tantivy requires the per-thread heap budget to stay above
 *  15 MB — the binding raises an `InvalidArgumentError` otherwise. */
const MIN_HEAP_BYTES_PER_THREAD = 15_000_000

/** Async-or-sync row stream the caller hands to the runtime. */
type SearchDocRowSource = AsyncIterable<SearchDocInputV2> | Iterable<SearchDocInputV2>

export interface RunTantivyRebuildInput {
  /** Absolute bundle root (same value the planner uses). */
  bundleRoot: string
  /** Highest `rowid` in the current `search_docs` projection. */
  currentMaxRowid: number
  /** Total `count(*)` of the current `search_docs` projection.
   *  Recorded in the checkpoint regardless of the plan outcome. */
  sourceDocCount: number
  /** Row producer keyed on the planned mode. The caller is
   *  responsible for ordering rows by `rowid` ascending and for
   *  filtering by `lastIndexedRowid` when the plan is incremental. */
  loadRows: (plan: RebuildPlan) => SearchDocRowSource | Promise<SearchDocRowSource>
  /** Caller flag (`prosa index-v2 tantivy --overwrite`). */
  overwriteRequested?: boolean
  /** Override the native writer heap; defaults to 300 MiB. */
  heapBytes?: number
  /** Override the native writer thread count; defaults to 4. */
  numThreads?: number
}

/** Outcome of a runtime rebuild attempt. */
export type RuntimeResult =
  /** Planner determined the index is already up-to-date; no native
   *  writer was constructed. The checkpoint is the prior on-disk
   *  value, unchanged. */
  | {
      kind: 'skipped'
      plan: Extract<RebuildPlan, { kind: 'skip' }>
      checkpoint: IndexCheckpointV2
    }
  /** Rebuild (full or incremental) succeeded. The checkpoint has
   *  been persisted with `status: 'ready'`. */
  | {
      kind: 'rebuilt'
      plan: Extract<RebuildPlan, { kind: 'full' | 'incremental' }>
      checkpoint: IndexCheckpointV2
      /** Number of documents added during this run (not the cumulative
       *  index count for incremental rebuilds — that lives in the
       *  checkpoint). */
      addedDocCount: number
      /** Reported `indexed_doc_count` after the run. For full this is
       *  the same as `addedDocCount`; for incremental it is
       *  `prior.indexed_doc_count + addedDocCount`. */
      indexedDocCount: number
      /** New `last_indexed_rowid` recorded in the checkpoint. */
      newMaxRowid: number
    }
  /** Native writer threw mid-rebuild. The checkpoint has been
   *  persisted with `status: 'failed'` so the next run re-plans
   *  as `full / prior_run_failed`. The thrown error is also
   *  rethrown. */
  | {
      kind: 'failed'
      plan: RebuildPlan
      checkpoint: IndexCheckpointV2
      errorMessage: string
    }

/** Lazy native module reference; resolved on first call so the import
 *  cost is not paid by the read-only status surfaces that share the
 *  package. */
type TantivyModule = typeof import('@oxdev03/node-tantivy-binding')

async function loadTantivy(): Promise<TantivyModule> {
  return await import('@oxdev03/node-tantivy-binding')
}

/** Build the v2 Tantivy schema using the canonical field order /
 *  tokenizer mapping pinned in `./schema.ts`. The tokenizer name is
 *  only passed when it differs from the binding default; the binding
 *  uses `default` (en_stem) when omitted. */
function buildSchema(tantivy: TantivyModule): InstanceType<TantivyModule['Schema']> {
  const builder = new tantivy.SchemaBuilder()
  for (const field of TANTIVY_SCHEMA_FIELDS) {
    if (field.tokenizer === 'default') {
      builder.addTextField(field.name, { stored: true })
    } else {
      builder.addTextField(field.name, { stored: true, tokenizerName: field.tokenizer })
    }
  }
  return builder.build()
}

/** Materialise one row into a stored Tantivy `Document`. Field order
 *  mirrors `TANTIVY_SCHEMA_FIELDS`; `null` projection values land as
 *  empty strings via `toTantivyFieldMap`. */
function buildDocument(tantivy: TantivyModule, row: SearchDocInputV2): InstanceType<TantivyModule['Document']> {
  const doc = new tantivy.Document()
  const flat = toTantivyFieldMap(row)
  for (const field of TANTIVY_SCHEMA_FIELDS) {
    doc.addText(field.name, flat[field.name] ?? '')
  }
  return doc
}

/** Validate the native-writer tuning before the binding raises an
 *  opaque Rust panic. The Tantivy contract requires
 *  `heap >= 3 MB * threads`. */
function assertWriterTuning(heapBytes: number, numThreads: number): void {
  if (!Number.isFinite(heapBytes) || heapBytes <= 0) {
    throw new Error(`runTantivyRebuild: heapBytes must be a positive number, got ${heapBytes}`)
  }
  if (!Number.isInteger(numThreads) || numThreads <= 0) {
    throw new Error(`runTantivyRebuild: numThreads must be a positive integer, got ${numThreads}`)
  }
  const minHeap = MIN_HEAP_BYTES_PER_THREAD * numThreads
  if (heapBytes < minHeap) {
    throw new Error(
      `runTantivyRebuild: heapBytes (${heapBytes}) must be at least ${minHeap} for ${numThreads} thread(s) (the binding requires ${MIN_HEAP_BYTES_PER_THREAD} bytes per thread).`,
    )
  }
}

/**
 * Run a Tantivy rebuild against the v2 bundle layout. Plans the run,
 * applies the plan, and persists the resulting `IndexCheckpointV2`.
 *
 * `skip` plans return immediately without opening the native writer.
 * `full` plans clear the index directory (CQ-094/CQ-096 hardened) and
 * rebuild from scratch. `incremental` plans open the existing index,
 * delete-by-`doc_id` for each incoming row (so re-imported docs replace
 * the prior copy — same contract as the v1 implementation), and
 * append new documents.
 *
 * On native-writer failure the checkpoint is persisted with
 * `status: 'failed'` and the original error is rethrown.
 */
export async function runTantivyRebuild(input: RunTantivyRebuildInput): Promise<RuntimeResult> {
  const heapBytes = input.heapBytes ?? DEFAULT_HEAP_BYTES
  const numThreads = input.numThreads ?? DEFAULT_NUM_THREADS
  assertWriterTuning(heapBytes, numThreads)

  const { plan, checkpoint: priorCheckpoint } = await planTantivyRebuildFromBundle({
    bundleRoot: input.bundleRoot,
    currentMaxRowid: input.currentMaxRowid,
    overwriteRequested: input.overwriteRequested,
  })

  if (plan.kind === 'skip') {
    return { kind: 'skipped', plan, checkpoint: priorCheckpoint }
  }

  const fingerprint = currentTantivySchemaFingerprint()
  try {
    const tantivy = await loadTantivy()
    const schema = buildSchema(tantivy)

    let index: InstanceType<TantivyModule['Index']>
    const indexDir = tantivyIndexDir(input.bundleRoot)
    if (plan.kind === 'full') {
      await clearTantivyIndexDir(input.bundleRoot)
      // `reuse: false` is correct for a fresh dir: the binding writes
      // a new `meta.json` and creates the index from scratch.
      index = new tantivy.Index(schema, indexDir, false)
    } else {
      index = tantivy.Index.open(indexDir)
    }

    const writer = index.writer(heapBytes, numThreads)
    let addedDocCount = 0
    let maxRowid = plan.kind === 'incremental' ? plan.lastIndexedRowid : 0

    try {
      const rows = await input.loadRows(plan)
      for await (const row of rows as AsyncIterable<SearchDocInputV2>) {
        if (plan.kind === 'incremental') {
          // Match the v1 contract: re-imported docs replace the prior
          // copy. `doc_id` uses the `raw` tokenizer, so the stored
          // value maps 1:1 to a single deletable term.
          writer.deleteDocumentsByTerm('doc_id', row.doc_id)
        }
        writer.addDocument(buildDocument(tantivy, row))
        addedDocCount += 1
        if (row.rowid > maxRowid) maxRowid = row.rowid
      }
      writer.commit()
    } finally {
      // Always drain merging threads so the directory lock is released
      // even if the loop above threw. Throws here surface to the outer
      // catch and route to `failed`.
      writer.waitMergingThreads()
    }

    const priorIndexed = priorCheckpoint.indexed_doc_count ?? 0
    const indexedDocCount = plan.kind === 'full' ? addedDocCount : priorIndexed + addedDocCount

    const newCheckpoint = checkpointAfterRebuild({
      prior: priorCheckpoint,
      fingerprint,
      newMaxRowid: maxRowid,
      indexedDocCount,
      sourceDocCount: input.sourceDocCount,
    })
    await writeIndexCheckpoint(input.bundleRoot, newCheckpoint)

    return {
      kind: 'rebuilt',
      plan,
      checkpoint: newCheckpoint,
      addedDocCount,
      indexedDocCount,
      newMaxRowid: maxRowid,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const failedCheckpoint = checkpointAfterFailure({ prior: priorCheckpoint, errorMessage })
    try {
      await writeIndexCheckpoint(input.bundleRoot, failedCheckpoint)
    } catch {
      // Persist failure best-effort: if the disk is unhappy too,
      // surface the original error to the caller. The planner will
      // see the prior checkpoint on the next run and re-route based
      // on the index dir probe.
    }
    if (err instanceof Error) throw err
    throw new Error(errorMessage)
  }
}
