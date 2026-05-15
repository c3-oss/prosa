import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printRows } from '../../src/cli/output.js'

interface Captured {
  lines: string[]
}

function captureStdout(): Captured {
  const captured: Captured = { lines: [] }
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    captured.lines.push(...text.split('\n').filter((l) => l.length > 0))
    return true
  }) as typeof process.stdout.write
  vi.spyOn(process.stdout, 'write')
  return Object.assign(captured, {
    restore: (): void => {
      process.stdout.write = original
    },
  }) as Captured & { restore: () => void }
}

describe('printRows table format', () => {
  let captured: ReturnType<typeof captureStdout>
  beforeEach(() => {
    captured = captureStdout()
  })
  afterEach(() => {
    ;(captured as unknown as { restore: () => void }).restore()
  })

  it('renders columns naturally when everything fits', () => {
    printRows([{ a: 'one', b: 'two' }], {
      format: 'table',
      columns: ['a', 'b'],
      terminalWidth: 80,
    })
    expect(captured.lines).toEqual(['a    b  ', '---  ---', 'one  two'])
  })

  it('truncates a cell that exceeds the per-column cap', () => {
    printRows([{ name: 'a-very-long-value-here', n: 42 }], {
      format: 'table',
      columns: ['name', 'n'],
      maxColumnWidths: { name: 10 },
      terminalWidth: 80,
    })
    expect(captured.lines[2]).toBe('a-very-lo…  42')
  })

  it('shrinks the widest column when the natural width exceeds the terminal', () => {
    printRows(
      [
        {
          a: 'short',
          b: 'this-is-a-very-long-string-that-must-be-truncated-to-fit',
          c: 'medium-text',
        },
      ],
      {
        format: 'table',
        columns: ['a', 'b', 'c'],
        terminalWidth: 30,
      },
    )
    const headerLine = captured.lines[0] ?? ''
    expect(headerLine.length).toBeLessThanOrEqual(30)
    const dataLine = captured.lines[2] ?? ''
    expect(dataLine).toContain('…')
    expect(dataLine.length).toBeLessThanOrEqual(30)
  })

  it('uses tail truncation when the column is listed as a tail column', () => {
    printRows([{ path: '/Users/foo/long/nested/path/to/file.ts' }], {
      format: 'table',
      columns: ['path'],
      maxColumnWidths: { path: 15 },
      terminalWidth: 80,
      tailColumns: new Set(['path']),
    })
    const dataLine = captured.lines[2] ?? ''
    expect(dataLine.startsWith('…')).toBe(true)
    expect(dataLine.trimEnd().endsWith('file.ts')).toBe(true)
  })

  it('keeps the natural width when no truncation is needed', () => {
    printRows([{ x: 'hi' }], {
      format: 'table',
      columns: ['x'],
      maxColumnWidths: { x: 100 },
      terminalWidth: 80,
    })
    expect(captured.lines[2]).toBe('hi')
  })

  it('respects the header floor — never shrinks below the header length', () => {
    printRows(
      [
        {
          long_header_name: '12345',
          other: 'data',
        },
      ],
      {
        format: 'table',
        columns: ['long_header_name', 'other'],
        terminalWidth: 10, // impossibly small; header floor keeps headers intact
      },
    )
    expect(captured.lines[0]).toMatch(/^long_header_name/)
  })
})

describe('printRows json format', () => {
  let captured: ReturnType<typeof captureStdout>
  beforeEach(() => {
    captured = captureStdout()
  })
  afterEach(() => {
    ;(captured as unknown as { restore: () => void }).restore()
  })

  it('ignores maxColumnWidths and terminalWidth — JSON stays complete', () => {
    printRows([{ name: 'a-very-long-value-here', n: 42 }], {
      format: 'json',
      columns: ['name', 'n'],
      maxColumnWidths: { name: 5 },
      terminalWidth: 10,
    })
    const parsed = JSON.parse(captured.lines.join('\n')) as Array<{ name: string; n: number }>
    expect(parsed[0]?.name).toBe('a-very-long-value-here')
    expect(parsed[0]?.n).toBe(42)
  })

  it('includes meta as top-level fields when provided', () => {
    printRows([{ a: 1 }], {
      format: 'json',
      columns: ['a'],
      meta: { query: 'foo', count: 1 },
    })
    const parsed = JSON.parse(captured.lines.join('\n')) as {
      query: string
      count: number
      rows: Array<{ a: number }>
    }
    expect(parsed.query).toBe('foo')
    expect(parsed.count).toBe(1)
    expect(parsed.rows[0]?.a).toBe(1)
  })
})
