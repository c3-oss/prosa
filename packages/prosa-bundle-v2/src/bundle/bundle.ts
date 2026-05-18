// Bundle handle. Opens/initializes a bundle directory, manages the advisory
// lock and the in-memory head pointer.

import { randomBytes } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'

import {
  type BundleHeadV2,
  base32LowerNoPad,
  bundleRootFromRows,
  canonicalTimestamp,
  crossEntityRoot,
  rawSourceRootFromEntries,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import { makeEmptyHead, readHead, writeHead } from './head.js'
import { type BundlePaths, bundlePaths } from './layout.js'
import { type LockHandle, acquireLock } from './lock.js'

const PARSER_VERSION = '2.0.0-lane1'

export type InitBundleOptions = {
  /** Override the auto-generated storeId. Useful for tests. */
  storeId?: string
  /** Override `createdAt`. Useful for deterministic tests. */
  createdAt?: string
}

export type OpenBundleOptions = {
  /** If true, skip acquiring `prosa.lock`. Read-only callers should pass this. */
  readOnly?: boolean
}

export class Bundle {
  private constructor(
    public readonly paths: BundlePaths,
    public head: BundleHeadV2,
    private lock: LockHandle | null,
  ) {}

  static async init(root: string, options: InitBundleOptions = {}): Promise<Bundle> {
    await mkdir(root, { recursive: true })
    const paths = bundlePaths(root)
    // Create the directory tree before touching the lock to avoid a stale
    // lock in a half-initialized tree.
    await mkdir(paths.epochs, { recursive: true })
    await mkdir(paths.casPacks, { recursive: true })
    await mkdir(paths.casLarge, { recursive: true })
    await mkdir(paths.rawSourcePacks, { recursive: true })
    await mkdir(paths.index, { recursive: true })
    await mkdir(paths.search, { recursive: true })
    await mkdir(paths.tmp, { recursive: true })

    const lock = await acquireLock(paths.lock)

    try {
      const storeId = options.storeId ?? defaultStoreId()
      const createdAt = options.createdAt ?? canonicalTimestamp(new Date().toISOString())

      // Empty bundle roots:
      // - bundleRoot = cross-entity root over 13 zero subroots
      // - rawSourceRoot = empty raw-source set = 32 zero bytes
      const bundleRoot = toHex(bundleRootFromRows({}))
      const rawSourceRoot = toHex(rawSourceRootFromEntries([]))

      // manifestDigest pin: BLAKE3 over the canonical-JSON manifest body
      // (without the digest itself). At init we hash a deterministic empty
      // manifest envelope.
      const manifestBody = JSON.stringify({
        bundleFormat: 2,
        storeId,
        epoch: 0,
        parserVersion: PARSER_VERSION,
        createdAt,
        previousBundleRoot: null,
        bundleRoot,
        rawSourceRoot,
        segments: [],
      })
      const manifestDigest = `blake3:${toHex(blake3(new TextEncoder().encode(manifestBody)))}`

      const head = makeEmptyHead({
        storeId,
        storePath: root,
        parserVersion: PARSER_VERSION,
        createdAt,
        bundleRoot,
        rawSourceRoot,
        manifestDigest,
      })
      await writeHead(paths.headJson, head)
      return new Bundle(paths, head, lock)
    } catch (err) {
      await lock.release()
      throw err
    }
  }

  static async open(root: string, options: OpenBundleOptions = {}): Promise<Bundle> {
    const paths = bundlePaths(root)
    const headStat = await stat(paths.headJson).catch(() => null)
    if (!headStat) {
      throw new Error(`openBundle: ${paths.headJson} not found — did you call initBundle()?`)
    }

    let lock: LockHandle | null = null
    if (!options.readOnly) {
      lock = await acquireLock(paths.lock)
    }
    try {
      const head = await readHead(paths.headJson)
      const bundle = new Bundle(paths, head, lock)
      // CQ-025: on every writer open, drop any leftover `tmp/epoch-*` or
      // `tmp/index-rebuild-*` from a crashed sealer/rebuilder before any
      // new lifecycle call touches `tmp/`. Read-only callers skip the
      // cleanup so they cannot mutate the bundle.
      if (!options.readOnly) {
        const { reapStaleTmp } = await import('../epoch/lifecycle.js')
        await reapStaleTmp(bundle)
      }
      return bundle
    } catch (err) {
      if (lock) await lock.release()
      throw err
    }
  }

  /**
   * Replace the in-memory and on-disk head pointer atomically. Callers must
   * have already produced a valid `BundleHeadV2` (e.g. from `sealEpoch`).
   */
  async swapHead(next: BundleHeadV2): Promise<void> {
    if (next.bundleFormat !== 2) {
      throw new Error(`swapHead: expected bundleFormat=2, got ${next.bundleFormat}`)
    }
    if (next.previousBundleRoot !== null && next.previousBundleRoot !== this.head.bundleRoot) {
      throw new Error(
        `swapHead: previousBundleRoot ${next.previousBundleRoot} does not match current bundleRoot ${this.head.bundleRoot}`,
      )
    }
    if (next.epoch !== this.head.epoch + 1 && !(this.head.epoch === 0 && next.epoch === 0)) {
      // Allow re-write of the same epoch only when both are 0 (init flow).
      throw new Error(`swapHead: epoch must monotonically increase (current ${this.head.epoch}, next ${next.epoch})`)
    }
    await writeHead(this.paths.headJson, next)
    this.head = next
  }

  async close(): Promise<void> {
    if (this.lock) {
      await this.lock.release()
      this.lock = null
    }
  }
}

function defaultStoreId(): string {
  // 16 random bytes -> base32 lower no-pad. The resulting id matches the
  // canonical id regex `[a-z0-9][a-z0-9_:-]*`.
  return `st_${base32LowerNoPad(randomBytes(16))}`
}

// Convenience re-exports
export async function initBundle(root: string, options?: InitBundleOptions): Promise<Bundle> {
  return Bundle.init(root, options)
}

export async function openBundle(root: string, options?: OpenBundleOptions): Promise<Bundle> {
  return Bundle.open(root, options)
}

// Inner test helper: compute the canonical roots for an empty bundle. Used
// by epoch lifecycle code in Lane 1.3 once it can populate the canonical
// projection rows.
export function emptyProjectionRoot(): string {
  return toHex(crossEntityRoot({}))
}
