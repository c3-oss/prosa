// Bundle v2 on-disk directory layout helpers.
//
// See docs/rearch-2/02-lane-1-local-store.md "Bundle directory layout".

import { join } from 'node:path'

export type BundlePaths = {
  root: string
  headJson: string
  lock: string
  epochs: string
  cas: string
  casPacks: string
  casLarge: string
  rawSources: string
  rawSourcePacks: string
  index: string
  search: string
  tmp: string
}

export function bundlePaths(root: string): BundlePaths {
  return {
    root,
    headJson: join(root, 'head.json'),
    lock: join(root, 'prosa.lock'),
    epochs: join(root, 'epochs'),
    cas: join(root, 'cas'),
    casPacks: join(root, 'cas', 'packs'),
    casLarge: join(root, 'cas', 'large'),
    rawSources: join(root, 'raw_sources'),
    rawSourcePacks: join(root, 'raw_sources', 'packs'),
    index: join(root, 'index'),
    search: join(root, 'search'),
    tmp: join(root, 'tmp'),
  }
}

export function epochDir(root: string, epoch: number): string {
  return join(root, 'epochs', String(epoch))
}

export function epochTmpDir(root: string, epoch: number): string {
  return join(root, 'tmp', `epoch-${epoch}`)
}

export function indexRebuildDir(root: string, uuid: string): string {
  return join(root, 'tmp', `index-rebuild-${uuid}`)
}

export function indexOldDir(root: string, timestamp: string): string {
  return join(root, `index-old-${timestamp}`)
}
