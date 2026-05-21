// Lightweight bundle head reader for the local-read services.
//
// `prosa-derived-v2` does not depend on `prosa-bundle-v2`, so we parse
// `head.json` directly via `node:fs/promises`. The schema fields the
// local readers actually need are a small subset of `BundleHeadV2`:
// `epoch`, `storeId`, and `storePath`. Anything else is ignored so
// future head additions don't break the reader.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type BundleHeadSnapshot = {
  bundleRoot: string
  epoch: number
  storeId: string
  storePath: string
}

/**
 * Read `<bundleRoot>/head.json` and return the small slice the local
 * read services depend on. Throws if the file is missing or the
 * payload is missing `bundleFormat: 2` (a v1 bundle is not a v2
 * bundle, even if it happens to live in the same directory).
 */
export async function loadBundleHead(bundleRoot: string): Promise<BundleHeadSnapshot> {
  const headPath = join(bundleRoot, 'head.json')
  let text: string
  try {
    text = await readFile(headPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`loadBundleHead: ${headPath} not found (bundle has never been compiled)`)
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`loadBundleHead: ${headPath} is not valid JSON: ${(err as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`loadBundleHead: ${headPath} is not a JSON object`)
  }
  const head = parsed as Record<string, unknown>
  if (head.bundleFormat !== 2) {
    throw new Error(`loadBundleHead: ${headPath} bundleFormat is ${String(head.bundleFormat)}; expected 2`)
  }
  const epoch = head.epoch
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`loadBundleHead: ${headPath} epoch is not a non-negative integer: ${String(epoch)}`)
  }
  return {
    bundleRoot,
    epoch,
    storeId: typeof head.storeId === 'string' ? head.storeId : '',
    storePath: typeof head.storePath === 'string' ? head.storePath : bundleRoot,
  }
}
