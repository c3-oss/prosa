// Read-side benchmark: compare query latency on two parquet variants.

import path from 'node:path';
import { DuckDBConnection } from '@duckdb/node-api';

const OUT_BASE = '/tmp/prosa-bench-parquet';
const VARIANTS = ['default_snappy_default_rg_', 'snappy_rg_100k', 'zstd_1_rg_100k', 'zstd_3_rg_100k'];
const TABLES = ['objects', 'search_docs', 'tool_results', 'raw_records', 'events', 'content_blocks'];

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  process.stdout.write(`  ${label}: ${(performance.now() - t0).toFixed(0)}ms\n`);
  return r;
}

async function bench(variant: string) {
  const dir = path.join(OUT_BASE, variant);
  console.log(`\n--- ${variant} ---`);
  const conn = await DuckDBConnection.create();
  try {
    for (const t of TABLES) {
      await conn.run(
        `CREATE OR REPLACE VIEW ${t} AS SELECT * FROM read_parquet('${path.join(dir, t + '.parquet')}')`,
      );
    }

    // 1. Cold count(*) — exercises metadata only
    await timed('count search_docs', async () => {
      const r = await conn.runAndReadAll('SELECT count(*) FROM search_docs');
      r.getRowObjects();
    });

    // 2. Aggregation that scans many rows
    await timed('group by field_kind', async () => {
      const r = await conn.runAndReadAll(
        `SELECT field_kind, count(*) AS n FROM search_docs GROUP BY 1 ORDER BY n DESC`,
      );
      r.getRowObjects();
    });

    // 3. Filter on a string field
    await timed('filter tool_results.is_error=1', async () => {
      const r = await conn.runAndReadAll(
        `SELECT count(*) FROM tool_results WHERE is_error = 1`,
      );
      r.getRowObjects();
    });

    // 4. Multi-column projection over big table
    await timed('project events first 10k', async () => {
      const r = await conn.runAndReadAll(
        `SELECT event_id, session_id, ordinal, source_type FROM events ORDER BY ordinal LIMIT 10000`,
      );
      r.getRowObjects();
    });

    // 5. Substring filter on tool_results.preview (large text column)
    await timed("substring filter tool_results.preview", async () => {
      const r = await conn.runAndReadAll(
        `SELECT count(*) FROM tool_results WHERE preview LIKE '%error%'`,
      );
      r.getRowObjects();
    });
  } finally {
    conn.closeSync();
  }
}

async function main() {
  for (const v of VARIANTS) {
    // run twice; report second (warm)
    await bench(v);
    await bench(v);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
