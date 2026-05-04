import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBConnection } from '@duckdb/node-api';
import { closeBundle, openBundle } from '../../core/bundle.js';

export const PARQUET_TABLES = [
  'objects',
  'source_files',
  'import_batches',
  'raw_records',
  'import_errors',
  'uncertainties',
  'projects',
  'sessions',
  'turns',
  'events',
  'messages',
  'content_blocks',
  'tool_calls',
  'tool_results',
  'artifacts',
  'edges',
  'search_docs',
] as const;

export type ParquetTable = (typeof PARQUET_TABLES)[number];

export interface ParquetExportOptions {
  bundlePath: string;
  outDir?: string;
}

export interface ParquetExportResult {
  outDir: string;
  manifestPath: string;
  files: Record<ParquetTable, string>;
  counts: Record<ParquetTable, number>;
}

export interface DuckDbQueryOptions {
  parquetDir: string;
  sql: string;
}

export interface DuckDbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface BundleSnapshot {
  dbPath: string;
  schemaVersion: number;
  parserVersion: string;
  defaultOutDir: string;
  counts: Record<ParquetTable, number>;
}

export async function exportBundleParquet(
  options: ParquetExportOptions,
): Promise<ParquetExportResult> {
  const snapshot = await openBundleSnapshot(options.bundlePath);
  const outDir = path.resolve(options.outDir ?? snapshot.defaultOutDir);
  await mkdir(outDir, { recursive: true });

  const files = Object.fromEntries(
    PARQUET_TABLES.map((table) => [table, path.join(outDir, `${table}.parquet`)]),
  ) as Record<ParquetTable, string>;
  const manifestPath = path.join(outDir, 'manifest.json');

  for (const file of [...Object.values(files), manifestPath]) {
    await rm(file, { force: true });
  }

  const connection = await createDuckDbConnection();
  try {
    await attachSqlite(connection, snapshot.dbPath);
    for (const table of PARQUET_TABLES) {
      await connection.run(
        `COPY (SELECT * FROM prosa.${quoteIdentifier(table)}) TO ${sqlString(files[table])} (FORMAT parquet)`,
      );
    }
  } finally {
    connection.closeSync();
  }

  const manifest = {
    exported_at: new Date().toISOString(),
    source_db: snapshot.dbPath,
    schema_version: snapshot.schemaVersion,
    parser_version: snapshot.parserVersion,
    tables: Object.fromEntries(
      PARQUET_TABLES.map((table) => [
        table,
        {
          file: path.basename(files[table]),
          rows: snapshot.counts[table],
        },
      ]),
    ),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { outDir, manifestPath, files, counts: snapshot.counts };
}

export async function queryDuckDbParquet(options: DuckDbQueryOptions): Promise<DuckDbQueryResult> {
  const parquetDir = path.resolve(options.parquetDir);
  const connection = await createDuckDbConnection();
  try {
    for (const table of PARQUET_TABLES) {
      await connection.run(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(table)} AS SELECT * FROM read_parquet(${sqlString(
          path.join(parquetDir, `${table}.parquet`),
        )})`,
      );
    }

    const reader = await connection.runAndReadAll(options.sql);
    return {
      columns: reader.deduplicatedColumnNames(),
      rows: reader.getRowObjectsJson() as Record<string, unknown>[],
    };
  } catch (error) {
    if (isMissingParquetError(error)) {
      throw new Error(
        `Parquet export not found in ${parquetDir}; run \`prosa export parquet --store <path>\` first`,
      );
    }
    throw error;
  } finally {
    connection.closeSync();
  }
}

async function createDuckDbConnection(): Promise<DuckDBConnection> {
  return DuckDBConnection.create();
}

async function attachSqlite(connection: DuckDBConnection, dbPath: string): Promise<void> {
  try {
    await connection.run('INSTALL sqlite');
    await connection.run('LOAD sqlite');
    await connection.run(`ATTACH ${sqlString(dbPath)} AS prosa (TYPE sqlite)`);
  } catch (error) {
    throw new Error(
      `DuckDB could not attach prosa.sqlite via the sqlite extension: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function openBundleSnapshot(bundlePath: string): Promise<BundleSnapshot> {
  const bundle = await openBundle(bundlePath);
  try {
    const counts = Object.fromEntries(
      PARQUET_TABLES.map((table) => {
        const row = bundle.db
          .prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`)
          .get();
        return [table, row?.n ?? 0];
      }),
    ) as Record<ParquetTable, number>;

    return {
      dbPath: bundle.paths.db,
      schemaVersion: bundle.manifest.schema_version,
      parserVersion: bundle.manifest.parser_version,
      defaultOutDir: bundle.paths.parquet,
      counts,
    };
  } finally {
    closeBundle(bundle);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isMissingParquetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No files found|does not exist|not found/i.test(message) && /\.parquet/i.test(message);
}
