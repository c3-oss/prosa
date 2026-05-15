/** Output formats accepted by table-oriented CLI commands. */
export const OUTPUT_FORMATS = ['interactive', 'table', 'json', 'csv'] as const

/** Supported CLI output format names. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

const COL_SEPARATOR = '  '
const RULE_CHAR = '-'
const ELLIPSIS = '…'
const DEFAULT_TERMINAL_WIDTH = 200
const MIN_COLUMN_WIDTH = 6

/** Parse and validate an output format, returning the caller's fallback when omitted. */
export function parseOutputFormat(value: string | undefined, fallback: OutputFormat): OutputFormat {
  if (value === undefined) return fallback
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat
  throw new Error(`invalid --output-format: ${value} (expected one of ${OUTPUT_FORMATS.join(', ')})`)
}

/** Options for rendering CLI rows in table, interactive, JSON, or CSV form. */
export interface PrintOptions {
  format: OutputFormat
  columns: readonly string[]
  /** Optional metadata for json output (query applied, total matched, etc.). */
  meta?: Record<string, unknown>
  /**
   * Hard cap for individual columns in table/interactive output. Cells longer
   * than the cap are truncated with `…`. Ignored for json/csv.
   */
  maxColumnWidths?: Readonly<Record<string, number>>
  /**
   * Columns rendered with `…` at the start (tail visible) instead of the end.
   * Useful for paths so the leaf is preserved when truncated.
   */
  tailColumns?: Readonly<Set<string>>
  /**
   * Override terminal width detection. Tests pass this to make rendering
   * deterministic; production code leaves it undefined to fall back to
   * `process.stdout.columns` and finally a wide default for piped output.
   */
  terminalWidth?: number
}

/** Render rows to stdout using the selected CLI output format. */
export function printRows(rows: readonly object[], opts: PrintOptions): void {
  switch (opts.format) {
    case 'json':
      printJson(rows, opts)
      return
    case 'csv':
      printCsv(rows, opts)
      return
    case 'table':
    case 'interactive':
      printTable(rows, opts)
      return
  }
}

function printJson(rows: readonly object[], opts: PrintOptions): void {
  const out = opts.meta ? { ...opts.meta, rows } : rows
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
}

function printCsv(rows: readonly object[], opts: PrintOptions): void {
  const columns = opts.columns
  process.stdout.write(`${columns.map(csvField).join(',')}\n`)
  for (const row of rows) {
    const record = row as Record<string, unknown>
    const line = columns.map((column) => csvField(formatCell(record[column]))).join(',')
    process.stdout.write(`${line}\n`)
  }
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function printTable(rows: readonly object[], opts: PrintOptions): void {
  const columns = opts.columns
  const terminalWidth = opts.terminalWidth ?? process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH
  const maxColumnWidths = opts.maxColumnWidths ?? {}
  const tailColumns = opts.tailColumns ?? new Set<string>()

  // Pass 1: collect every cell's natural string and the column's natural width.
  const naturalCells = rows.map((row) => {
    const record = row as Record<string, unknown>
    return columns.map((column) => formatCell(record[column]))
  })
  const widths = columns.map((column, index) => {
    let max = column.length
    for (const row of naturalCells) {
      const cell = row[index] ?? ''
      if (cell.length > max) max = cell.length
    }
    return max
  })

  // Pass 2: apply per-column hard caps.
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]
    if (column === undefined) continue
    const cap = maxColumnWidths[column]
    if (cap !== undefined && (widths[i] ?? 0) > cap) widths[i] = cap
  }

  // Pass 3: if the total exceeds the terminal, shave width off the widest
  // column repeatedly until it fits or every column is at its floor. The floor
  // is the larger of `MIN_COLUMN_WIDTH` and the header length, so headers
  // remain readable even under pressure.
  const separatorBudget = (columns.length - 1) * COL_SEPARATOR.length
  const floors = columns.map((column) => Math.max(MIN_COLUMN_WIDTH, column.length))
  while (totalWidth(widths) + separatorBudget > terminalWidth) {
    const candidate = pickShrinkCandidate(widths, floors)
    if (candidate === null) break
    widths[candidate] = (widths[candidate] ?? 0) - 1
  }

  // Pass 4: render header, rule, and rows, truncating cells to their column.
  const header = columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join(COL_SEPARATOR)
  const rule = columns.map((_, index) => RULE_CHAR.repeat(widths[index] ?? 0)).join(COL_SEPARATOR)
  process.stdout.write(`${header}\n${rule}\n`)
  for (const cellRow of naturalCells) {
    const line = cellRow
      .map((cell, index) => {
        const width = widths[index] ?? 0
        const column = columns[index] ?? ''
        const fitted = fitCell(cell, width, tailColumns.has(column))
        return fitted.padEnd(width)
      })
      .join(COL_SEPARATOR)
    process.stdout.write(`${line}\n`)
  }
}

function totalWidth(widths: readonly number[]): number {
  let sum = 0
  for (const w of widths) sum += w
  return sum
}

function pickShrinkCandidate(widths: readonly number[], floors: readonly number[]): number | null {
  let bestIndex = -1
  let bestWidth = -1
  for (let i = 0; i < widths.length; i++) {
    const current = widths[i] ?? 0
    const floor = floors[i] ?? MIN_COLUMN_WIDTH
    if (current > floor && current > bestWidth) {
      bestWidth = current
      bestIndex = i
    }
  }
  return bestIndex === -1 ? null : bestIndex
}

function fitCell(text: string, width: number, tail: boolean): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return ELLIPSIS
  if (tail) return ELLIPSIS + text.slice(text.length - (width - 1))
  return text.slice(0, width - 1) + ELLIPSIS
}

function formatCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
