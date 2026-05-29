import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BundleNotInitializedError, defaultBundlePath } from '@c3-oss/prosa-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asCliBundleOpenError } from '../../src/cli/bundle.js'
import { initCommand } from '../../src/cli/commands/init.js'
import { createCliLogger } from '../../src/cli/logger.js'
import { parseMcpTransport, parseSearchEngine, parseSourceTool } from '../../src/cli/parsers.js'

type Capture = {
  lines: string[]
  restore: () => void
}

function captureStdout(): Capture {
  const original = process.stdout.write.bind(process.stdout)
  const lines: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    lines.push(...text.split('\n').filter(Boolean))
    return true
  }) as typeof process.stdout.write
  return {
    lines,
    restore: () => {
      process.stdout.write = original
    },
  }
}

describe('parser helpers', () => {
  it('accepts supported values and rejects unknown values', () => {
    expect(parseSearchEngine('fts5')).toBe('fts5')
    expect(parseSearchEngine('tantivy')).toBe('tantivy')
    expect(() => parseSearchEngine('elastic')).toThrow(/invalid search engine/)

    expect(parseMcpTransport('stdio')).toBe('stdio')
    expect(parseMcpTransport('http')).toBe('http')
    expect(() => parseMcpTransport('tcp')).toThrow(/invalid transport/)

    expect(parseSourceTool(undefined)).toBeUndefined()
    expect(parseSourceTool('codex')).toBe('codex')
    expect(() => parseSourceTool('unknown')).toThrow(/invalid source tool/)
  })
})

describe('bundle error mapping', () => {
  it('maps missing default and explicit bundles to actionable CLI errors', () => {
    const previous = process.env.PROSA_STORE
    process.env.PROSA_STORE = ''
    try {
      const defaultError = asCliBundleOpenError(new BundleNotInitializedError(defaultBundlePath(), 'missing-directory'))
      expect(defaultError).toBeInstanceOf(Error)
      expect(String((defaultError as Error).message)).toContain('Run `prosa v1 init`')

      const explicitError = asCliBundleOpenError(new BundleNotInitializedError('/tmp/prosa-custom', 'missing-manifest'))
      expect(explicitError).toBeInstanceOf(Error)
      expect(String((explicitError as Error).message)).toContain('prosa v1 init --store /tmp/prosa-custom')

      const unknown = new Error('boom')
      expect(asCliBundleOpenError(unknown)).toBe(unknown)
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, 'PROSA_STORE')
      } else {
        process.env.PROSA_STORE = previous
      }
    }
  })
})

describe('createCliLogger', () => {
  it('creates pretty and JSON stderr loggers', () => {
    const pretty = createCliLogger({ verbose: false, jsonLogs: false })
    const json = createCliLogger({ verbose: true, jsonLogs: true })

    expect(pretty.level).toBe('info')
    expect(json.level).toBe('debug')
  })
})

describe('initCommand', () => {
  let root: string
  let stdout: Capture

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'prosa-init-command-'))
    stdout = captureStdout()
  })

  afterEach(async () => {
    stdout.restore()
    await rm(root, { recursive: true, force: true })
  })

  it('initializes a bundle and opens it again with --force-existing', async () => {
    const store = path.join(root, 'store')

    await initCommand().parseAsync(['node', 'init', '--store', store])
    await initCommand().parseAsync(['node', 'init', '--store', store, '--force-existing'])

    expect(stdout.lines[0]).toBe(`initialized prosa bundle at ${store}`)
    expect(stdout.lines[1]).toBe(`bundle already exists at ${store}`)
  })
})
