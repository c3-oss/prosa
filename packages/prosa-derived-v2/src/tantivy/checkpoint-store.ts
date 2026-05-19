// Tantivy index checkpoint persistence.
//
// The rebuild planner decides between `skip` / `incremental` / `full`
// from an `IndexCheckpointV2` value. This module is the on-disk side:
// it loads the prior checkpoint from
// `<bundleRoot>/derived/tantivy/checkpoint.json` (or returns null when
// missing) and writes the post-run checkpoint atomically.
//
// "Atomic" here means: write the new bytes to a same-directory temp
// file, fsync the file, `rename(tmp, checkpoint.json)` (POSIX atomic
// on the same filesystem), then fsync the parent directory so the
// rename survives a crash. A torn write cannot leave a partially
// written `checkpoint.json` because the final path is only ever
// updated via rename — mirroring the `head.json` pattern in
// `prosa-bundle-v2`. CQ-093.
//
// The on-disk representation is canonical JSON (sorted keys, no
// whitespace) so the same checkpoint always produces the same bytes
// and a diff tool can compare two runs.

import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { syncDir } from '@c3-oss/prosa-bundle-v2'

import { derivedPaths } from '../derived-layout.js'
import { canonicalJsonBytes } from '../session-blob/framing.js'

import { detectDerivedTantivyIntermediateSymlink } from './index-dir.js'
import { EMPTY_INDEX_CHECKPOINT, type IndexCheckpointV2 } from './rebuild-plan.js'

const VALID_STATUSES = new Set<IndexCheckpointV2['status']>(['idle', 'building', 'ready', 'failed', null])

/** Canonical on-disk path of the Tantivy checkpoint inside a bundle. */
export function tantivyCheckpointPath(bundleRoot: string): string {
  return derivedPaths(bundleRoot).tantivyCheckpoint
}

/**
 * Load the prior Tantivy checkpoint from disk. Returns `null` when the
 * file does not exist (fresh bundle / never indexed) so callers can
 * fall back to `EMPTY_INDEX_CHECKPOINT` without catching `ENOENT`
 * themselves. Throws when the file exists but is malformed — a corrupt
 * checkpoint is a real integrity failure the planner must not paper
 * over with `EMPTY_INDEX_CHECKPOINT`.
 *
 * CQ-103 containment: refuses to follow a symlinked managed
 * intermediate (`<bundleRoot>/derived`, `<bundleRoot>/derived/tantivy`)
 * or a symlinked final `checkpoint.json`. The same write-side guard
 * is applied by `writeIndexCheckpoint`. A symlinked checkpoint
 * surface is treated as integrity corruption — checkpoint state
 * feeds Tantivy rebuild planning, so following an external target
 * would let the planner consume rebuild state outside the bundle.
 * Throws rather than returning `null` so the failure surfaces; the
 * existing `null`-on-ENOENT contract is reserved for genuinely
 * absent state.
 */
export async function readIndexCheckpoint(bundleRoot: string): Promise<IndexCheckpointV2 | null> {
  const intermediate = await detectDerivedTantivyIntermediateSymlink(bundleRoot)
  if (intermediate.escape) {
    throw new Error(
      `readIndexCheckpoint: refusing to read — intermediate path ${intermediate.path} is a symlink (CQ-103). Resolve the symlink configuration manually before retrying.`,
    )
  }
  const path = tantivyCheckpointPath(bundleRoot)
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(
        `readIndexCheckpoint: refusing to read ${path} — final path is a symlink (CQ-103). Resolve the symlink configuration manually before retrying.`,
      )
    }
    if (!st.isFile()) {
      throw new Error(`readIndexCheckpoint: ${path} exists but is not a regular file`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
  const bytes = await readFile(path)
  const text = bytes.toString('utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`readIndexCheckpoint: malformed JSON at ${path}: ${(err as Error).message}`)
  }
  return assertCheckpointShape(parsed, path)
}

/**
 * Persist a post-run checkpoint atomically: write canonical JSON to a
 * same-directory temp file, fsync the file, rename onto the final
 * `checkpoint.json` path (POSIX atomic on the same filesystem), then
 * fsync the parent directory so the rename survives a crash. A torn
 * write cannot corrupt the final path; readers always see either the
 * prior good checkpoint or the new one. On rename failure the temp
 * file is unlinked best-effort. CQ-093.
 */
export async function writeIndexCheckpoint(bundleRoot: string, checkpoint: IndexCheckpointV2): Promise<void> {
  const path = tantivyCheckpointPath(bundleRoot)
  const dir = dirname(path)
  // CQ-096-parallel containment: refuse to write the checkpoint
  // when any managed intermediate (`<bundleRoot>/derived`,
  // `<bundleRoot>/derived/tantivy`) is a symlink. Without this,
  // `mkdir(dir, { recursive: true })` would resolve the
  // intermediate symlink and write the checkpoint outside the
  // bundle. Same policy as `clearTantivyIndexDir`: throw with
  // the offending path quoted so an operator can investigate.
  const intermediate = await detectDerivedTantivyIntermediateSymlink(bundleRoot)
  if (intermediate.escape) {
    throw new Error(
      `writeIndexCheckpoint: refusing to write — intermediate path ${intermediate.path} is a symlink (CQ-096). Resolve the symlink configuration manually before retrying.`,
    )
  }
  const bytes = canonicalJsonBytes(checkpointToCanonicalShape(checkpoint))
  // Same-directory temp; suffix is unique per call so concurrent
  // writers cannot collide on the same temp path (the planner
  // contract is single-writer per bundle, but the temp suffix is
  // cheap and removes a foot-gun).
  const tmp = `${path}.tmp.${process.pid}.${randomSuffix()}`
  await mkdir(dir, { recursive: true })
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, path)
  } catch (err) {
    // Best-effort cleanup so a failed rename does not leave a stale
    // temp behind. Never touch the final path: the prior good
    // checkpoint is still there.
    try {
      await unlink(tmp)
    } catch {
      // ignore
    }
    throw err
  }
  await syncDir(dir)
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
}

/**
 * Read the prior checkpoint, falling back to `EMPTY_INDEX_CHECKPOINT`
 * when no file exists. Convenience for callers that always want a
 * non-null checkpoint to feed into the planner. A malformed file
 * still throws.
 */
export async function readIndexCheckpointOrEmpty(bundleRoot: string): Promise<IndexCheckpointV2> {
  return (await readIndexCheckpoint(bundleRoot)) ?? EMPTY_INDEX_CHECKPOINT
}

function checkpointToCanonicalShape(c: IndexCheckpointV2): Record<string, unknown> {
  // Spelling out the fields rather than spreading guarantees the
  // canonical serializer sees every key (it filters out `undefined`)
  // and that we never accidentally persist a non-IndexCheckpointV2
  // property added elsewhere.
  return {
    error_message: c.error_message,
    indexed_doc_count: c.indexed_doc_count,
    last_indexed_rowid: c.last_indexed_rowid,
    schema_fingerprint: c.schema_fingerprint,
    source_doc_count: c.source_doc_count,
    status: c.status,
  }
}

function assertCheckpointShape(value: unknown, path: string): IndexCheckpointV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`readIndexCheckpoint: ${path} is not a JSON object`)
  }
  const obj = value as Record<string, unknown>
  const nullableNumber = (key: string): number | null => {
    const v = obj[key]
    if (v === null || v === undefined) return null
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`readIndexCheckpoint: ${path} field ${key} is not a finite number or null`)
    }
    return v
  }
  const nullableString = (key: string): string | null => {
    const v = obj[key]
    if (v === null || v === undefined) return null
    if (typeof v !== 'string') {
      throw new Error(`readIndexCheckpoint: ${path} field ${key} is not a string or null`)
    }
    return v
  }
  const statusRaw = obj.status === undefined ? null : obj.status
  if (!VALID_STATUSES.has(statusRaw as IndexCheckpointV2['status'])) {
    throw new Error(`readIndexCheckpoint: ${path} field status has unexpected value ${JSON.stringify(statusRaw)}`)
  }
  return {
    last_indexed_rowid: nullableNumber('last_indexed_rowid'),
    schema_fingerprint: nullableString('schema_fingerprint'),
    status: statusRaw as IndexCheckpointV2['status'],
    indexed_doc_count: nullableNumber('indexed_doc_count'),
    source_doc_count: nullableNumber('source_doc_count'),
    error_message: nullableString('error_message'),
  }
}
