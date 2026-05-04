import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Db, closeDb, openDb } from './db.js';
import { currentSchemaVersion, runMigrations } from './schema/migrate.js';
import { PROSA_PARSER_VERSION, PROSA_SCHEMA_VERSION } from './version.js';

export interface BundleManifest {
  version: 1;
  parser_version: string;
  schema_version: number;
  created_at: string;
  hash_alg: 'blake3';
  default_compression: 'zstd';
}

export interface Bundle {
  path: string;
  db: Db;
  manifest: BundleManifest;
  paths: {
    db: string;
    manifest: string;
    objects: string;
    rawSources: string;
    search: string;
    tantivy: string;
    exports: string;
    parquet: string;
    lock: string;
  };
}

export function defaultBundlePath(): string {
  const env = process.env.PROSA_STORE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), '.prosa');
}

function bundlePaths(rootPath: string): Bundle['paths'] {
  return {
    db: path.join(rootPath, 'prosa.sqlite'),
    manifest: path.join(rootPath, 'manifest.json'),
    objects: path.join(rootPath, 'objects'),
    rawSources: path.join(rootPath, 'raw', 'sources'),
    search: path.join(rootPath, 'search'),
    tantivy: path.join(rootPath, 'search', 'tantivy'),
    exports: path.join(rootPath, 'exports'),
    parquet: path.join(rootPath, 'parquet'),
    lock: path.join(rootPath, 'prosa.lock'),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a fresh bundle at `rootPath`. Fails if the directory already contains
 * a manifest (use openBundle for that case).
 */
export async function initBundle(rootPath: string): Promise<Bundle> {
  const resolved = path.resolve(rootPath);
  const paths = bundlePaths(resolved);

  await mkdir(resolved, { recursive: true });

  if (await exists(paths.manifest)) {
    throw new Error(
      `bundle already exists at ${resolved} (found manifest.json) — use openBundle instead`,
    );
  }

  await mkdir(paths.objects, { recursive: true });
  await mkdir(paths.rawSources, { recursive: true });
  await mkdir(paths.search, { recursive: true });
  await mkdir(paths.tantivy, { recursive: true });
  await mkdir(paths.exports, { recursive: true });
  await mkdir(paths.parquet, { recursive: true });

  const manifest: BundleManifest = {
    version: 1,
    parser_version: PROSA_PARSER_VERSION,
    schema_version: PROSA_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    hash_alg: 'blake3',
    default_compression: 'zstd',
  };

  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const db = openDb(paths.db);
  runMigrations(db);

  return { path: resolved, db, manifest, paths };
}

/**
 * Open an existing bundle. Applies pending migrations if the schema is older
 * than the current code expects.
 */
export async function openBundle(rootPath: string): Promise<Bundle> {
  const resolved = path.resolve(rootPath);
  const paths = bundlePaths(resolved);

  const dirStat = await stat(resolved).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`bundle path not found or not a directory: ${resolved}`);
  }
  if (!(await exists(paths.manifest))) {
    throw new Error(
      `no manifest.json in ${resolved} — initialize first with \`prosa init --store ${resolved}\``,
    );
  }

  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as BundleManifest;
  await mkdir(paths.search, { recursive: true });
  await mkdir(paths.tantivy, { recursive: true });
  const db = openDb(paths.db);
  runMigrations(db);

  const currentVersion = currentSchemaVersion(db);
  if (currentVersion !== PROSA_SCHEMA_VERSION) {
    closeDb(db);
    throw new Error(`schema version mismatch (db=${currentVersion}, code=${PROSA_SCHEMA_VERSION})`);
  }

  // Refresh manifest's parser_version stamp on every open; useful for telemetry.
  if (manifest.parser_version !== PROSA_PARSER_VERSION) {
    manifest.parser_version = PROSA_PARSER_VERSION;
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return { path: resolved, db, manifest, paths };
}

export function closeBundle(bundle: Bundle): void {
  closeDb(bundle.db);
}
