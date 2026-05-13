export const OUTPUT_FORMATS = ['interactive', 'table', 'json', 'csv'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

const COL_SEPARATOR = '  '
const RULE_CHAR = '-'

export function parseOutputFormat(value: string | undefined, fallback: OutputFormat): OutputFormat {
  if (value === undefined) return fallback
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat
  throw new Error(`invalid --output-format: ${value} (expected one of ${OUTPUT_FORMATS.join(', ')})`)
}

export interface PrintOptions {
  format: OutputFormat
  columns: readonly string[]
  /** Optional metadata for json output (query applied, total matched, etc.). */
  meta?: Record<string, unknown>
}

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
  const widths = columns.map((column) => column.length)
  const cells = rows.map((row) => {
    const record = row as Record<string, unknown>
    return columns.map((column, index) => {
      const text = formatCell(record[column])
      const width = widths[index] ?? 0
      if (text.length > width) widths[index] = text.length
      return text
    })
  })

  const header = columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join(COL_SEPARATOR)
  const rule = columns.map((_, index) => RULE_CHAR.repeat(widths[index] ?? 0)).join(COL_SEPARATOR)
  process.stdout.write(`${header}\n${rule}\n`)
  for (const cellRow of cells) {
    const line = cellRow.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(COL_SEPARATOR)
    process.stdout.write(`${line}\n`)
  }
}

function formatCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
