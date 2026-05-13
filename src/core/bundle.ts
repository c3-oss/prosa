import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type Db, closeDb, openDb } from './db.js'
import { currentSchemaVersion, runMigrations } from './schema/migrate.js'
import { PROSA_PARSER_VERSION, PROSA_SCHEMA_VERSION } from './version.js'

/**
 * Durable metadata written to `manifest.json` at the root of a bundle.
 *
 * The manifest records the store format and the parser/schema versions that
 * last opened the bundle. SQLite remains the authoritative schema source after
 * migrations; `openBundle` refreshes the version stamps when they drift.
 */
export interface BundleManifest {
  /** Manifest file format version. */
  version: 1
  /** Parser version that last initialized or opened the bundle. */
  parser_version: string
  /** SQLite schema version expected by the last opener. */
  schema_version: number
  /** ISO timestamp for bundle creation. */
  created_at: string
  /** Hash algorithm used for content-addressed object IDs. */
  hash_alg: 'blake3'
  /** Default compression used for stored CAS payloads. */
  default_compression: 'zstd'
}

/**
 * Open bundle handle shared by core services.
 *
 * `path` is the resolved bundle root. `paths` contains all managed locations
 * under that root, including SQLite, CAS/object storage, raw source copies,
 * search indexes, and generated exports.
 */
export interface Bundle {
  /** Absolute bundle root path. */
  path: string
  /** Open better-sqlite3 database handle for `prosa.sqlite`. */
  db: Db
  /** Parsed bundle manifest metadata. */
  manifest: BundleManifest
  /** Canonical absolute paths for bundle-managed files and directories. */
  paths: {
    /** SQLite database file. */
    db: string
    /** Manifest JSON file. */
    manifest: string
    /** Main CAS fanout directory. */
    objects: string
    /** Raw preserved source-file directory. */
    rawSources: string
    /** Search-related sidecar root. */
    search: string
    /** Tantivy index directory. */
    tantivy: string
    /** Generated export root. */
    exports: string
    /** Default Parquet export directory. */
    parquet: string
    /** Reserved lock-file path for future single-writer coordination. */
    lock: string
  }
}

/**
 * Resolve the default bundle root.
 *
 * `PROSA_STORE` wins when set; otherwise the local-first store lives in
 * `~/.prosa`. The return value is absolute in both cases.
 */
export function defaultBundlePath(): string {
  const env = process.env.PROSA_STORE
  if (env && env.length > 0) return path.resolve(env)
  return path.join(os.homedir(), '.prosa')
}

/**
 * Derive every managed filesystem path for a bundle without touching disk.
 */
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
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Create a fresh bundle at `rootPath`. Fails if the directory already contains
 * a manifest (use openBundle for that case).
 *
 * Side effects: creates the bundle directory tree, writes `manifest.json`,
 * opens `prosa.sqlite`, and applies all schema migrations. The caller owns the
 * returned database handle and must close it via `closeBundle`.
 */
export async function initBundle(rootPath: string): Promise<Bundle> {
  const resolved = path.resolve(rootPath)
  const paths = bundlePaths(resolved)

  await mkdir(resolved, { recursive: true })

  if (await exists(paths.manifest)) {
    throw new Error(`bundle already exists at ${resolved} (found manifest.json) — use openBundle instead`)
  }

  await mkdir(paths.objects, { recursive: true })
  await mkdir(paths.rawSources, { recursive: true })
  await mkdir(paths.search, { recursive: true })
  await mkdir(paths.tantivy, { recursive: true })
  await mkdir(paths.exports, { recursive: true })
  await mkdir(paths.parquet, { recursive: true })

  const manifest: BundleManifest = {
    version: 1,
    parser_version: PROSA_PARSER_VERSION,
    schema_version: PROSA_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    hash_alg: 'blake3',
    default_compression: 'zstd',
  }

  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const db = openDb(paths.db)
  runMigrations(db)

  return { path: resolved, db, manifest, paths }
}

/**
 * Open an existing bundle. Applies pending migrations if the schema is older
 * than the current code expects.
 *
 * Fails when the root is missing, lacks a manifest, or the migrated database
 * version still does not match the code-time schema version. On success it may
 * rewrite only manifest version metadata.
 */
export async function openBundle(rootPath: string): Promise<Bundle> {
  const resolved = path.resolve(rootPath)
  const paths = bundlePaths(resolved)

  const dirStat = await stat(resolved).catch(() => null)
  if (!dirStat?.isDirectory()) {
    throw new Error(`bundle path not found or not a directory: ${resolved}`)
  }
  if (!(await exists(paths.manifest))) {
    throw new Error(`no manifest.json in ${resolved} — initialize first with \`prosa init --store ${resolved}\``)
  }

  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as BundleManifest
  await mkdir(paths.search, { recursive: true })
  await mkdir(paths.tantivy, { recursive: true })
  const db = openDb(paths.db)
  runMigrations(db)

  const currentVersion = currentSchemaVersion(db)
  if (currentVersion !== PROSA_SCHEMA_VERSION) {
    closeDb(db)
    throw new Error(`schema version mismatch (db=${currentVersion}, code=${PROSA_SCHEMA_VERSION})`)
  }

  // Refresh manifest's parser_version and schema_version stamps on every open.
  // schema_version drifts after migrations apply to an older bundle; rewriting
  // the manifest keeps it in sync with the actual db state and avoids a stale
  // metadata warning from `prosa doctor`.
  let manifestDirty = false
  if (manifest.parser_version !== PROSA_PARSER_VERSION) {
    manifest.parser_version = PROSA_PARSER_VERSION
    manifestDirty = true
  }
  if (manifest.schema_version !== currentVersion) {
    manifest.schema_version = currentVersion
    manifestDirty = true
  }
  if (manifestDirty) {
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  return { path: resolved, db, manifest, paths }
}

/**
 * Open an existing bundle or transparently initialize one if the store path is
 * missing or has not been initialized yet.
 *
 * Fails when `rootPath` exists but is not a directory. This is the CLI-friendly
 * entrypoint for commands that should create the store on first use.
 */
export async function openOrInitBundle(rootPath: string): Promise<Bundle> {
  const resolved = path.resolve(rootPath)
  const paths = bundlePaths(resolved)

  const dirStat = await stat(resolved).catch(() => null)
  if (dirStat && !dirStat.isDirectory()) {
    throw new Error(`bundle path not found or not a directory: ${resolved}`)
  }

  if (!dirStat || !(await exists(paths.manifest))) {
    return await initBundle(resolved)
  }

  return await openBundle(resolved)
}

/**
 * Close the SQLite handle associated with a bundle.
 */
export function closeBundle(bundle: Bundle): void {
  closeDb(bundle.db)
}
