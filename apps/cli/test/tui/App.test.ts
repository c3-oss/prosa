import { PassThrough, Writable } from 'node:stream'
import type { Bundle } from '@c3-oss/prosa-core'
import { type Instance, render } from 'ink'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/tui/App.js'
import { type TempBundle, createTempBundle } from '../helpers/tmp-bundle.js'

class TestStdin extends PassThrough {
  isTTY = true

  setRawMode(): this {
    return this
  }

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }
}

class CaptureStream extends Writable {
  columns = 120
  rows = 12
  isTTY = false
  chunks: string[] = []

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    callback()
  }

  get output(): string {
    return stripAnsi(this.chunks.join(''))
  }
}

interface AppHarness {
  stdin: TestStdin
  stdout: CaptureStream
  stderr: CaptureStream
  instance: Instance
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

function currentFrame(harness: AppHarness): string {
  for (const chunk of harness.stdout.chunks.toReversed()) {
    const text = stripAnsi(chunk)
    if (text.trim().length > 0) return text
  }
  return ''
}

function selectedLine(frame: string): string {
  const pointer = `${String.fromCharCode(0x203a)} `
  return frame.split('\n').find((line) => line.startsWith(pointer)) ?? ''
}

async function settle(harness: AppHarness): Promise<void> {
  await harness.instance.waitUntilRenderFlush()
}

async function waitForFrame(harness: AppHarness, predicate: (frame: string) => boolean): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    await settle(harness)
    const frame = currentFrame(harness)
    if (predicate(frame)) return frame
  }
  throw new Error(`timed out waiting for frame:\n${currentFrame(harness)}`)
}

async function press(harness: AppHarness, input: string): Promise<void> {
  harness.stdin.write(input)
  if (input === '\u001B') {
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  await settle(harness)
}

function mountApp(bundle: Bundle): AppHarness {
  const stdin = new TestStdin()
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  const instance = render(createElement(App, { bundle }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    interactive: false,
    patchConsole: false,
  })

  return { stdin, stdout, stderr, instance }
}

function seedTuiRows(bundle: Bundle): void {
  const insertSession = bundle.db.prepare(
    `INSERT INTO sessions (
       session_id, source_tool, source_session_id, title, start_ts, end_ts,
       cwd_initial, git_branch_initial, model_first, model_last, status
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertSession.run(
    'sess-codex-new',
    'codex',
    'codex-new',
    'Latest Codex Work',
    '2026-05-03T22:00:00.000Z',
    '2026-05-03T22:05:00.000Z',
    '/work/prosa',
    'main',
    'gpt-5',
    'gpt-5',
    'ok',
  )
  insertSession.run(
    'sess-claude',
    'claude',
    'claude-one',
    'Needle Claude Work',
    '2026-05-03T21:00:00.000Z',
    '2026-05-03T21:05:00.000Z',
    '/work/other',
    'feature',
    'opus',
    'opus',
    'ok',
  )
  insertSession.run(
    'sess-codex-old',
    'codex',
    'codex-old',
    'Older Codex Work',
    '2026-05-03T20:00:00.000Z',
    '2026-05-03T20:05:00.000Z',
    '/tmp/prosa',
    null,
    'gpt-4.1',
    'gpt-4.1',
    'ok',
  )

  bundle.db
    .prepare(
      `INSERT INTO search_docs (
         doc_id, entity_type, entity_id, session_id, timestamp, role, field_kind, text
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'doc-needle',
      'message',
      'message-needle',
      'sess-claude',
      '2026-05-03T21:01:00.000Z',
      'assistant',
      'text',
      'needle search result from claude',
    )
}

describe('App TUI', () => {
  let temp: TempBundle
  let harness: AppHarness | undefined

  beforeEach(async () => {
    temp = await createTempBundle()
    seedTuiRows(temp.bundle)
  })

  afterEach(async () => {
    harness?.instance.unmount()
    harness = undefined
    await temp.cleanup()
  })

  it('renders sessions and supports list navigation', async () => {
    harness = mountApp(temp.bundle)

    let frame = await waitForFrame(harness, (text) => text.includes('count: 3'))
    expect(frame).toContain('Latest Codex Work')

    await press(harness, 'j')
    frame = currentFrame(harness)
    expect(selectedLine(frame)).toContain('Needle Claude Work')

    await press(harness, 'G')
    frame = currentFrame(harness)
    expect(selectedLine(frame)).toContain('Older Codex Work')

    await press(harness, 'k')
    frame = currentFrame(harness)
    expect(selectedLine(frame)).toContain('Needle Claude Work')
  })

  it('cycles the source filter, reloads, and exits from the session list', async () => {
    harness = mountApp(temp.bundle)
    await waitForFrame(harness, (text) => text.includes('source: all') && text.includes('count: 3'))

    await press(harness, 's')
    let frame = await waitForFrame(harness, (text) => text.includes('source: codex') && text.includes('count: 2'))
    expect(frame).toContain('Latest Codex Work')

    await press(harness, 'R')
    frame = await waitForFrame(harness, (text) => text.includes('reloaded 2 sessions'))
    expect(frame).toContain('source: codex')

    await press(harness, 'q')
    await harness.instance.waitUntilExit()
  })

  it('opens details, handles detail keys, and returns to sessions with escape', async () => {
    harness = mountApp(temp.bundle)
    await waitForFrame(harness, (text) => text.includes('Latest Codex Work'))

    await press(harness, '\r')
    let frame = await waitForFrame(harness, (text) => text.includes('# session sess-codex-new'))
    expect(frame).toContain('source: codex')
    expect(frame).toContain('models: gpt-5')

    await press(harness, 'j')
    await press(harness, 'G')
    await press(harness, 'g')
    await press(harness, 'g')

    frame = currentFrame(harness)
    expect(frame).toContain('# session sess-codex-new')

    await press(harness, '\u001B')
    frame = await waitForFrame(harness, (text) => text.includes('source: all'))
    expect(frame).toContain('Latest Codex Work')
  })

  it('runs search mode, opens a result, and cancels a prompt with escape', async () => {
    harness = mountApp(temp.bundle)
    await waitForFrame(harness, (text) => text.includes('count: 3'))

    await press(harness, '/')
    await press(harness, 'needle')
    let frame = currentFrame(harness)
    expect(frame).toContain('/ needle_')

    await press(harness, '\r')
    frame = await waitForFrame(harness, (text) => text.includes('search:') && text.includes('1 hits'))
    expect(frame).toContain('sess-claude')
    expect(frame).toContain('needle')

    await press(harness, '\r')
    frame = await waitForFrame(harness, (text) => text.includes('# session sess-claude'))
    expect(frame).toContain('source: claude')

    await press(harness, '\u001B')
    await waitForFrame(harness, (text) => text.includes('source: all'))

    await press(harness, '/')
    await press(harness, 'abc')
    await press(harness, '\u007F')
    frame = currentFrame(harness)
    expect(frame).toContain('/ ab_')

    await press(harness, '\u001B')
    frame = currentFrame(harness)
    expect(frame).not.toContain('/ ab_')
    expect(frame).toContain('source: all')
  })
})

describe('App TUI with no rows', () => {
  it('renders an empty sessions view without crashing on list input', async () => {
    const empty = await createTempBundle()
    try {
      const emptyHarness = mountApp(empty.bundle)
      try {
        const frame = await waitForFrame(emptyHarness, (text) => text.includes('count: 0'))
        expect(frame).toContain('source: all')
        await press(emptyHarness, 'j')
        expect(currentFrame(emptyHarness)).toContain('count: 0')
      } finally {
        emptyHarness.instance.unmount()
      }
    } finally {
      await empty.cleanup()
    }
  })
})
