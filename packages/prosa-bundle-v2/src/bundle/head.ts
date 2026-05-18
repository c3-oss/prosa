// `head.json` atomic write and read.
//
// `head.json` is the single source of truth for which epoch a bundle is
// currently pointing at. Updates are always: write to `head.json.tmp` in the
// same directory, fsync, then `fs.rename` (POSIX atomic on same filesystem).

import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { BundleCountsV2, BundleHeadV2, SegmentRef } from '@c3-oss/prosa-types-v2'

export const EMPTY_BUNDLE_COUNTS: BundleCountsV2 = {
  sourceFiles: 0,
  rawRecords: 0,
  objects: 0,
  sessions: 0,
  turns: 0,
  events: 0,
  messages: 0,
  contentBlocks: 0,
  toolCalls: 0,
  toolResults: 0,
  artifacts: 0,
  edges: 0,
  searchDocs: 0,
  projectionRows: 0,
}

/**
 * Read and JSON-parse `head.json`. Throws if the file is missing or invalid.
 */
export async function readHead(headPath: string): Promise<BundleHeadV2> {
  const raw = await readFile(headPath, 'utf8')
  const parsed = JSON.parse(raw) as BundleHeadV2
  if (parsed.bundleFormat !== 2) {
    throw new Error(`readHead: expected bundleFormat=2, got ${parsed.bundleFormat}`)
  }
  return parsed
}

/**
 * Atomically write `head.json`: write to `head.json.tmp`, fsync the data,
 * fsync the directory, then `fs.rename` to the final path.
 */
export async function writeHead(headPath: string, head: BundleHeadV2): Promise<void> {
  const tmp = `${headPath}.tmp`
  const body = `${JSON.stringify(head, null, 2)}\n`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(body, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, headPath)
  } catch (err) {
    // Cleanup on rename failure.
    try {
      await unlink(tmp)
    } catch {
      // ignore
    }
    throw err
  }
  // fsync the directory entry so the rename survives a crash.
  await syncDir(dirname(headPath))
}

async function syncDir(dir: string): Promise<void> {
  // Best-effort: not all platforms support fsync on directories. Open
  // read-only and sync; ignore errors (e.g. on macOS/APFS).
  try {
    const dh = await open(dir, 'r')
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  } catch {
    // ignore — directory fsync unsupported
  }
}

/**
 * Build a `BundleHeadV2` for a freshly initialized empty bundle: epoch 0,
 * no segments, all counts zero, roots computed from an empty projection.
 *
 * Caller supplies `storeId`, `storePath`, `parserVersion`, `createdAt` (the
 * canonical timestamp), `bundleRoot`, `rawSourceRoot`, and `manifestDigest`
 * — these are computed by the bundle layer at init time using
 * `prosa-types-v2` canonical helpers.
 */
export function makeEmptyHead(args: {
  storeId: string
  storePath: string
  parserVersion: string
  createdAt: string
  bundleRoot: string
  rawSourceRoot: string
  manifestDigest: string
}): BundleHeadV2 {
  const segments: SegmentRef[] = []
  return {
    bundleFormat: 2,
    storeId: args.storeId,
    storePath: args.storePath,
    epoch: 0,
    parserVersion: args.parserVersion,
    createdAt: args.createdAt,
    previousBundleRoot: null,
    bundleRoot: args.bundleRoot,
    rawSourceRoot: args.rawSourceRoot,
    manifestDigest: args.manifestDigest,
    counts: { ...EMPTY_BUNDLE_COUNTS },
    segments,
  }
}
