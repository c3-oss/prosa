// Benchmark: Parquet COPY with different compression / row-group settings
// against the actual prosa SQLite snapshot.

import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBConnection } from '@duckdb/node-api';

const DB_PATH = '/tmp/prosa-bench.sqlite';
const OUT_BASE = '/tmp/prosa-bench-parquet';

// Pick the largest tables — those dominate the export time.
const TABLES = [
  'objects', // 146MB
  'search_docs', // 109MB
  'tool_results', // 85MB
  'raw_records', // 84MB
  'events', // 50MB
  'content_blocks', // 46MB
] as const;

interface Variant {
  label: string;
  options: string;
}

const VARIANTS: Variant[] = [
  { label: 'default (snappy, default rg)', options: 'FORMAT parquet' },
  { label: 'snappy + rg=100k', options: 'FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 100000' },
  { label: 'zstd-1 + rg=100k', options: 'FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 1, ROW_GROUP_SIZE 100000' },
  { label: 'zstd-3 + rg=100k', options: 'FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3, ROW_GROUP_SIZE 100000' },
  { label: 'zstd-9 + rg=100k', options: 'FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 100000' },
  { label: 'zstd-3 + rg=1M', options: 'FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3, ROW_GROUP_SIZE 1000000' },
];

interface Result {
  variant: string;
  ms: number;
  totalBytes: number;
  perTable: Record<string, { ms: number; bytes: number }>;
}

async function attach(connection: DuckDBConnection): Promise<void> {
  await connection.run('INSTALL sqlite');
  await connection.run('LOAD sqlite');
  await connection.run(`ATTACH '${DB_PATH}' AS prosa (TYPE sqlite, READ_ONLY)`);
}

async function runVariant(variant: Variant): Promise<Result> {
  const outDir = path.join(OUT_BASE, variant.label.replace(/[^a-z0-9]+/gi, '_'));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const connection = await DuckDBConnection.create();
  await attach(connection);

  const perTable: Record<string, { ms: number; bytes: number }> = {};
  const t0 = performance.now();
  for (const table of TABLES) {
    const file = path.join(outDir, `${table}.parquet`);
    const tt0 = performance.now();
    await connection.run(
      `COPY (SELECT * FROM prosa.${table}) TO '${file}' (${variant.options})`,
    );
    const tms = performance.now() - tt0;
    const s = await stat(file);
    perTable[table] = { ms: tms, bytes: s.size };
  }
  const ms = performance.now() - t0;
  connection.closeSync();

  const totalBytes = Object.values(perTable).reduce((acc, v) => acc + v.bytes, 0);
  return { variant: variant.label, ms, totalBytes, perTable };
}

async function main() {
  await rm(OUT_BASE, { recursive: true, force: true });
  await mkdir(OUT_BASE, { recursive: true });

  const results: Result[] = [];
  for (const v of VARIANTS) {
    process.stdout.write(`Running: ${v.label}... `);
    const r = await runVariant(v);
    process.stdout.write(`${(r.ms / 1000).toFixed(2)}s, ${(r.totalBytes / 1024 / 1024).toFixed(1)} MB\n`);
    results.push(r);
  }

  console.log('\n=== Summary ===');
  console.log(
    'variant'.padEnd(34) + '  total_time   total_bytes   vs_default(time)  vs_default(size)',
  );
  const baseline = results[0]!;
  for (const r of results) {
    const tFactor = (r.ms / baseline.ms).toFixed(2) + 'x';
    const sFactor = (r.totalBytes / baseline.totalBytes).toFixed(2) + 'x';
    console.log(
      r.variant.padEnd(34) +
        `  ${(r.ms / 1000).toFixed(2)}s`.padStart(10) +
        `  ${(r.totalBytes / 1024 / 1024).toFixed(1)} MB`.padStart(12) +
        `  ${tFactor}`.padStart(18) +
        `  ${sFactor}`.padStart(16),
    );
  }

  console.log('\n=== Per-table for zstd-3 + rg=100k vs default ===');
  const def = results.find((r) => r.variant === 'default (snappy, default rg)')!;
  const zstd3 = results.find((r) => r.variant === 'zstd-3 + rg=100k')!;
  console.log(
    'table'.padEnd(20) +
      '  default_ms  default_MB  zstd3_ms  zstd3_MB  ms_ratio  size_ratio',
  );
  for (const t of TABLES) {
    const d = def.perTable[t]!;
    const z = zstd3.perTable[t]!;
    console.log(
      t.padEnd(20) +
        `  ${d.ms.toFixed(0)}`.padStart(11) +
        `  ${(d.bytes / 1024 / 1024).toFixed(1)}`.padStart(11) +
        `  ${z.ms.toFixed(0)}`.padStart(9) +
        `  ${(z.bytes / 1024 / 1024).toFixed(1)}`.padStart(9) +
        `  ${(z.ms / d.ms).toFixed(2)}x`.padStart(10) +
        `  ${(z.bytes / d.bytes).toFixed(2)}x`.padStart(11),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
