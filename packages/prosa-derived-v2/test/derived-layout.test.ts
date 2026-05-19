// Derived-layer directory layout tests.
//
// `derivedPaths` is the single source of truth for the on-disk
// layout of the derived/ tree. The tests pin every path so changing
// the layout requires updating tests in lockstep — this is the
// contract surface other features rely on.

import { describe, expect, it } from 'vitest'

import { type DerivedPaths, derivedPaths, derivedRoot } from '../src/derived-layout.js'
import { tantivyCheckpointPath } from '../src/tantivy/checkpoint-store.js'
import { tantivyIndexDir, tantivyMetaPath } from '../src/tantivy/index-dir.js'

describe('derivedPaths', () => {
  it('pins every canonical path under `<bundleRoot>/derived/`', () => {
    const p = derivedPaths('/tmp/bundle')
    const expected: DerivedPaths = {
      root: '/tmp/bundle',
      derived: '/tmp/bundle/derived',
      tantivy: '/tmp/bundle/derived/tantivy',
      tantivyIndex: '/tmp/bundle/derived/tantivy/index',
      tantivyMeta: '/tmp/bundle/derived/tantivy/index/meta.json',
      tantivyCheckpoint: '/tmp/bundle/derived/tantivy/checkpoint.json',
      sessionBlob: '/tmp/bundle/derived/session-blob',
      analytics: '/tmp/bundle/derived/analytics',
    }
    expect(p).toEqual(expected)
  })

  it('round-trips an arbitrary bundle root through `root`', () => {
    expect(derivedPaths('/tmp/b1').root).toBe('/tmp/b1')
    expect(derivedPaths('/tmp/b2').root).toBe('/tmp/b2')
  })

  it('derivedRoot returns the same value as `derivedPaths().derived`', () => {
    expect(derivedRoot('/tmp/bundle')).toBe(derivedPaths('/tmp/bundle').derived)
  })

  it('tantivyIndexDir delegates to derivedPaths.tantivyIndex (no path drift)', () => {
    expect(tantivyIndexDir('/tmp/bundle')).toBe(derivedPaths('/tmp/bundle').tantivyIndex)
  })

  it('tantivyMetaPath delegates to derivedPaths.tantivyMeta (no path drift)', () => {
    expect(tantivyMetaPath('/tmp/bundle')).toBe(derivedPaths('/tmp/bundle').tantivyMeta)
  })

  it('tantivyCheckpointPath delegates to derivedPaths.tantivyCheckpoint (no path drift)', () => {
    expect(tantivyCheckpointPath('/tmp/bundle')).toBe(derivedPaths('/tmp/bundle').tantivyCheckpoint)
  })

  it('handles a relative bundle root by joining segments without resolving', () => {
    // The function does not call `path.resolve()`; it composes
    // segments via `path.join()` so relative roots stay relative.
    const p = derivedPaths('relative/bundle')
    expect(p.derived).toBe('relative/bundle/derived')
    expect(p.tantivyIndex).toBe('relative/bundle/derived/tantivy/index')
  })
})
