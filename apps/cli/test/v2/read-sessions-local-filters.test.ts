// CQ-151 — local fallback rejects unsupported filters.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'

async function setupHarness(): Promise<{ root: string; configPath: string; storePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'prosa-local-filters-'))
  const configPath = path.join(root, 'config.json')
  const storePath = path.join(root, '.prosa')
  await mkdir(storePath, { recursive: true })
  await writeFile(configPath, JSON.stringify({ servers: {} }), { encoding: 'utf8', mode: 0o600 })
  return { root, configPath, storePath }
}

async function expectThrows(args: string[]): Promise<unknown> {
  try {
    await runCli(['node', 'prosa', ...args])
    throw new Error('expected runCli to throw')
  } catch (err) {
    return err
  }
}

describe('CQ-151 — local fallback rejects unsupported filters', () => {
  let h: { root: string; configPath: string; storePath: string }

  beforeEach(async () => {
    h = await setupHarness()
  })

  afterEach(async () => {
    await import('node:fs/promises').then((m) => m.rm(h.root, { recursive: true, force: true }))
  })

  it('prosa v2 read sessions --project fails closed in local mode', async () => {
    const err = await expectThrows([
      'v2',
      'read',
      'sessions',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--project',
      'p1',
      '--output-format',
      'json',
    ])
    expect((err as Error).message).toMatch(/local mode does not support --project/)
  })

  it('prosa v2 read sessions --cursor fails closed in local mode', async () => {
    const err = await expectThrows([
      'v2',
      'read',
      'sessions',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--cursor',
      'xxx',
      '--output-format',
      'json',
    ])
    expect((err as Error).message).toMatch(/local mode does not support --cursor/)
  })

  it('prosa v2 read sessions --count --project fails closed in local mode', async () => {
    const err = await expectThrows([
      'v2',
      'read',
      'sessions',
      '--count',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--project',
      'p1',
    ])
    expect((err as Error).message).toMatch(/local mode does not support --project/)
  })

  it('prosa v2 read search --role fails closed in local mode', async () => {
    const err = await expectThrows([
      'v2',
      'read',
      'search',
      'q',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--role',
      'user',
    ])
    expect((err as Error).message).toMatch(/local mode does not support --role/)
  })

  it('prosa v2 read search --tool-name fails closed in local mode', async () => {
    const err = await expectThrows([
      'v2',
      'read',
      'search',
      'q',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--tool-name',
      'shell',
    ])
    expect((err as Error).message).toMatch(/local mode does not support --tool-name/)
  })

  it('prosa v2 read search --errors-only fails closed in local mode', async () => {
    const err = await expectThrows([
      'v2',
      'read',
      'search',
      'q',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--errors-only',
    ])
    expect((err as Error).message).toMatch(/local mode does not support --errors-only/)
  })
})
