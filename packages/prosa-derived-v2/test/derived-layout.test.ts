// Derived-layer directory layout tests.
//
// `derivedPaths` is the single source of truth for the on-disk
// layout of the derived/ tree. The tests pin every path so changing
// the layout requires updating tests in lockstep — this is the
// contract surface other features rely on.

import { describe, expect, it } from 'vitest'

import {
  type DerivedPaths,
  derivedPaths,
  derivedRoot,
  sessionBlobEpochDir,
  sessionBlobPackPath,
} from '../src/derived-layout.js'
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

describe('sessionBlobEpochDir', () => {
  it('returns `<bundleRoot>/derived/session-blob/epoch-<n>`', () => {
    expect(sessionBlobEpochDir('/tmp/bundle', 0)).toBe('/tmp/bundle/derived/session-blob/epoch-0')
    expect(sessionBlobEpochDir('/tmp/bundle', 5)).toBe('/tmp/bundle/derived/session-blob/epoch-5')
    expect(sessionBlobEpochDir('/tmp/bundle', 99999)).toBe('/tmp/bundle/derived/session-blob/epoch-99999')
  })

  it('lives under `derivedPaths().sessionBlob` (no path drift)', () => {
    const layout = derivedPaths('/tmp/bundle')
    expect(sessionBlobEpochDir('/tmp/bundle', 3)).toBe(`${layout.sessionBlob}/epoch-3`)
  })

  it('rejects negative epochs', () => {
    expect(() => sessionBlobEpochDir('/tmp/bundle', -1)).toThrow(/non-negative safe integer/)
  })

  it('rejects non-integer epochs', () => {
    expect(() => sessionBlobEpochDir('/tmp/bundle', 1.5)).toThrow(/non-negative safe integer/)
    expect(() => sessionBlobEpochDir('/tmp/bundle', Number.NaN)).toThrow(/non-negative safe integer/)
    expect(() => sessionBlobEpochDir('/tmp/bundle', Number.POSITIVE_INFINITY)).toThrow(/non-negative safe integer/)
  })

  it('rejects non-number epochs', () => {
    // @ts-expect-error — testing runtime guard against typed misuse.
    expect(() => sessionBlobEpochDir('/tmp/bundle', '5')).toThrow(/non-negative safe integer/)
  })
})

describe('sessionBlobPackPath', () => {
  it('returns `<bundleRoot>/derived/session-blob/epoch-<n>/<session_id>.pack`', () => {
    expect(sessionBlobPackPath('/tmp/bundle', 'ses_abc123', 0)).toBe(
      '/tmp/bundle/derived/session-blob/epoch-0/ses_abc123.pack',
    )
    expect(sessionBlobPackPath('/tmp/bundle', 'ses_abc123', 42)).toBe(
      '/tmp/bundle/derived/session-blob/epoch-42/ses_abc123.pack',
    )
  })

  it('accepts the qualified external-key form (`prosa.session.v2:provider:key`)', () => {
    // Colons are valid in the canonical external-key grammar; the
    // pack-path resolver allows them so importers do not have to
    // sanitise IDs.
    expect(sessionBlobPackPath('/tmp/bundle', 'prosa.session.v2:claude:abc-123', 7)).toBe(
      '/tmp/bundle/derived/session-blob/epoch-7/prosa.session.v2:claude:abc-123.pack',
    )
  })

  it('composes via sessionBlobEpochDir (no path drift)', () => {
    expect(sessionBlobPackPath('/tmp/bundle', 'ses_x', 9)).toBe(`${sessionBlobEpochDir('/tmp/bundle', 9)}/ses_x.pack`)
  })

  it('handles a relative bundle root by joining segments without resolving', () => {
    expect(sessionBlobPackPath('relative/bundle', 'ses_x', 0)).toBe(
      'relative/bundle/derived/session-blob/epoch-0/ses_x.pack',
    )
  })

  it('rejects sessionId containing forward slash (path-traversal vector)', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', 'ses/escape', 0)).toThrow(/characters outside/)
  })

  it('rejects sessionId containing backslash (Windows path-traversal vector)', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', 'ses\\escape', 0)).toThrow(/characters outside/)
  })

  it('rejects sessionId containing `..` (relative-segment vector)', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', '..', 0)).toThrow(/'\.\.' segments/)
    expect(() => sessionBlobPackPath('/tmp/bundle', 'ses_..escape', 0)).toThrow(/'\.\.' segments/)
  })

  it('rejects sessionId of `.` (current-dir vector)', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', '.', 0)).toThrow(/'\.\.' segments|characters outside/)
  })

  it('rejects sessionId containing a null byte', () => {
    // The NUL is constructed at runtime via `String.fromCharCode(0)`
    // so the source file remains ordinary UTF-8 text (CQ-097): a
    // literal NUL byte in the source would make the file look like
    // binary data to `git diff`, `file`, and review tooling.
    expect(() => sessionBlobPackPath('/tmp/bundle', `ses_${String.fromCharCode(0)}abc`, 0)).toThrow(
      /characters outside/,
    )
  })

  it('rejects empty sessionId', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', '', 0)).toThrow(/non-empty string/)
  })

  it('rejects non-string sessionId', () => {
    // @ts-expect-error — testing runtime guard.
    expect(() => sessionBlobPackPath('/tmp/bundle', 42, 0)).toThrow(/non-empty string/)
    // @ts-expect-error — testing runtime guard.
    expect(() => sessionBlobPackPath('/tmp/bundle', null, 0)).toThrow(/non-empty string/)
  })

  it('rejects sessionId longer than 200 characters', () => {
    const tooLong = 'a'.repeat(201)
    expect(() => sessionBlobPackPath('/tmp/bundle', tooLong, 0)).toThrow(/exceeds 200 chars/)
  })

  it('accepts sessionId exactly 200 characters long (boundary)', () => {
    const max = 'a'.repeat(200)
    expect(sessionBlobPackPath('/tmp/bundle', max, 0)).toBe(`/tmp/bundle/derived/session-blob/epoch-0/${max}.pack`)
  })

  it('rejects sessionId containing spaces (filesystem-portability hardening)', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', 'ses with space', 0)).toThrow(/characters outside/)
  })

  it('rejects negative epochs', () => {
    expect(() => sessionBlobPackPath('/tmp/bundle', 'ses_x', -1)).toThrow(/non-negative safe integer/)
  })
})
