import path from 'node:path'
import { Command } from 'commander'
import { defaultBundlePath } from '../../core/bundle.js'
import { queryDuckDbParquet } from '../../services/export/parquet.js'
import { withBundle } from '../bundle.js'
import { parseOutputFormat, printRows } from '../output.js'

/** Create the `prosa query` command group for derived analytical queries. */
export function queryCommand(): Command {
  const duckdb = new Command('duckdb')
    .description('Run a DuckDB SQL query over exported Parquet tables.')
    .argument('<sql>', 'DuckDB SQL query')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--parquet-dir <path>', 'Parquet directory (default: <store>/parquet)')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(async (sql: string, options: { store: string; parquetDir?: string; outputFormat: string }) => {
      const format = parseOutputFormat(options.outputFormat, 'table')
      const parquetDir = options.parquetDir
        ? path.resolve(options.parquetDir)
        : await withBundle(options.store, (bundle) => bundle.paths.parquet)

      const result = await queryDuckDbParquet({ parquetDir, sql })
      printRows(result.rows, {
        format,
        columns: result.columns,
        meta: { query: sql, count: result.rows.length },
      })
    })

  return new Command('query').description('Run derived analytical queries.').addCommand(duckdb)
}
