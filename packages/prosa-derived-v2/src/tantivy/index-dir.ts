// Tantivy index directory layout + fast validity probe.
//
// The rebuild planner takes a boolean `indexDirValid` input and never
// touches the filesystem itself. This module is the on-disk probe
// that callers use to compute that boolean before invoking
// `planTantivyRebuild`.
//
// "Valid" here is a fast best-effort check: the directory exists,
// `meta.json` exists, and `meta.json` parses as JSON containing a
// `segments` array. The native writer (`@oxdev03/node-tantivy-binding`,
// added later) performs a full integrity check when it opens the
// index; this probe deliberately stops short of that so the planner
// can keep its decision pure-TS and ENOENT-tolerant.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Canonical on-disk path of the Tantivy index directory inside a
 *  bundle. The native writer creates `meta.json` plus the segment
 *  files under this path. */
export function tantivyIndexDir(bundleRoot: string): string {
  return join(bundleRoot, 'derived', 'tantivy', 'index')
}

/** Canonical path of the Tantivy `meta.json` manifest. */
export function tantivyMetaPath(bundleRoot: string): string {
  return join(tantivyIndexDir(bundleRoot), 'meta.json')
}

/**
 * Fast best-effort probe answering: should the planner treat the
 * on-disk Tantivy index as recoverable? Returns `true` when:
 *
 *   - `<bundleRoot>/derived/tantivy/index` exists and is a directory;
 *   - `<bundleRoot>/derived/tantivy/index/meta.json` exists and is a
 *     regular file;
 *   - `meta.json` parses as JSON and is an object containing a
 *     `segments` field that is an array (even an empty one).
 *
 * Returns `false` on any negative result, including ENOENT. The
 * native writer will still re-validate the on-disk index when it
 * opens it; this probe is intentionally cheap and lets the planner
 * decide between `full` (no/garbage index) and `incremental`
 * (recoverable index) without paying for the native binding.
 */
export async function tantivyIndexDirIsValid(bundleRoot: string): Promise<boolean> {
  const dir = tantivyIndexDir(bundleRoot)
  try {
    const dirStat = await stat(dir)
    if (!dirStat.isDirectory()) return false
  } catch {
    return false
  }
  const meta = tantivyMetaPath(bundleRoot)
  let bytes: Buffer
  try {
    const fileStat = await stat(meta)
    if (!fileStat.isFile()) return false
    bytes = await readFile(meta)
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf-8'))
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const segments = (parsed as Record<string, unknown>).segments
  if (!Array.isArray(segments)) return false
  return true
}
