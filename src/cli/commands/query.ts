import path from 'node:path';
import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import { queryDuckDbParquet } from '../../services/export/parquet.js';
import { parseOutputFormat, printRows } from '../output.js';

export function queryCommand(): Command {
  const duckdb = new Command('duckdb')
    .description('Run a DuckDB SQL query over exported Parquet tables.')
    .argument('<sql>', 'DuckDB SQL query')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--parquet-dir <path>', 'Parquet directory (default: <store>/parquet)')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(
      async (
        sql: string,
        options: { store: string; parquetDir?: string; outputFormat: string },
      ) => {
        const format = parseOutputFormat(options.outputFormat, 'table');
        const parquetDir = options.parquetDir
          ? path.resolve(options.parquetDir)
          : await defaultParquetDir(path.resolve(options.store));

        const result = await queryDuckDbParquet({ parquetDir, sql });
        printRows(result.rows as Record<string, unknown>[], {
          format,
          columns: result.columns,
          meta: { query: sql, count: result.rows.length },
        });
      },
    );

  return new Command('query').description('Run derived analytical queries.').addCommand(duckdb);
}

async function defaultParquetDir(storePath: string): Promise<string> {
  const bundle = await openBundle(storePath);
  try {
    return bundle.paths.parquet;
  } finally {
    closeBundle(bundle);
  }
}
