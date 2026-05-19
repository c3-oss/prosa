// Tantivy index checkpoint persistence.
//
// The rebuild planner decides between `skip` / `incremental` / `full`
// from an `IndexCheckpointV2` value. This module is the on-disk side:
// it loads the prior checkpoint from `<bundleRoot>/derived/tantivy/checkpoint.json`
// (or returns null when missing) and writes the post-run checkpoint
// using the bundle-v2 durable-write helper (write → fsync → close, then
// fsync the parent dir).
//
// The on-disk representation is canonical JSON (sorted keys, no
// whitespace) so the same checkpoint always produces the same bytes
// and a diff tool can compare two runs.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { syncDir, writeFileDurable } from '@c3-oss/prosa-bundle-v2'

import { canonicalJsonBytes } from '../session-blob/framing.js'

import { EMPTY_INDEX_CHECKPOINT, type IndexCheckpointV2 } from './rebuild-plan.js'

const VALID_STATUSES = new Set<IndexCheckpointV2['status']>(['idle', 'building', 'ready', 'failed', null])

/** Canonical on-disk path of the Tantivy checkpoint inside a bundle. */
export function tantivyCheckpointPath(bundleRoot: string): string {
  return join(bundleRoot, 'derived', 'tantivy', 'checkpoint.json')
}

/**
 * Load the prior Tantivy checkpoint from disk. Returns `null` when the
 * file does not exist (fresh bundle / never indexed) so callers can
 * fall back to `EMPTY_INDEX_CHECKPOINT` without catching `ENOENT`
 * themselves. Throws when the file exists but is malformed — a corrupt
 * checkpoint is a real integrity failure the planner must not paper
 * over with `EMPTY_INDEX_CHECKPOINT`.
 */
export async function readIndexCheckpoint(bundleRoot: string): Promise<IndexCheckpointV2 | null> {
  const path = tantivyCheckpointPath(bundleRoot)
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
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
 * Persist a post-run checkpoint. Writes canonical JSON via the bundle
 * durable-write helper, then fsyncs the parent directory so the file
 * survives a power loss between write and rename. Overwrites any prior
 * checkpoint atomically.
 */
export async function writeIndexCheckpoint(bundleRoot: string, checkpoint: IndexCheckpointV2): Promise<void> {
  const path = tantivyCheckpointPath(bundleRoot)
  const bytes = canonicalJsonBytes(checkpointToCanonicalShape(checkpoint))
  await writeFileDurable(path, bytes)
  await syncDir(dirname(path))
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
