export const OUTPUT_FORMATS = ['interactive', 'table', 'json', 'csv'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function parseOutputFormat(value: string | undefined, fallback: OutputFormat): OutputFormat {
  if (value === undefined) return fallback;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(
    `invalid --output-format: ${value} (expected one of ${OUTPUT_FORMATS.join(', ')})`,
  );
}

export interface PrintOptions {
  format: OutputFormat;
  columns: readonly string[];
  /** Optional metadata for json output (query applied, total matched, etc.). */
  meta?: Record<string, unknown>;
}

export function printRows(rows: readonly Record<string, unknown>[], opts: PrintOptions): void {
  switch (opts.format) {
    case 'json':
      printJson(rows, opts);
      return;
    case 'csv':
      printCsv(rows, opts);
      return;
    case 'table':
    case 'interactive':
      printTable(rows, opts);
      return;
  }
}

function printJson(rows: readonly Record<string, unknown>[], opts: PrintOptions): void {
  const out = opts.meta ? { ...opts.meta, rows } : rows;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function printCsv(rows: readonly Record<string, unknown>[], opts: PrintOptions): void {
  const cols = opts.columns;
  process.stdout.write(`${cols.map(csvField).join(',')}\n`);
  for (const row of rows) {
    const line = cols.map((c) => csvField(formatCell(row[c]))).join(',');
    process.stdout.write(`${line}\n`);
  }
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function printTable(rows: readonly Record<string, unknown>[], opts: PrintOptions): void {
  const cols = opts.columns;
  const widths = cols.map((c) => c.length);
  const cells = rows.map((row) =>
    cols.map((col, i) => {
      const text = formatCell(row[col]);
      const w = widths[i] ?? 0;
      if (text.length > w) widths[i] = text.length;
      return text;
    }),
  );

  const header = cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  const sep = cols.map((_, i) => '-'.repeat(widths[i] ?? 0)).join('  ');
  process.stdout.write(`${header}\n${sep}\n`);
  for (const cellRow of cells) {
    const line = cellRow.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
    process.stdout.write(`${line}\n`);
  }
}

function formatCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
