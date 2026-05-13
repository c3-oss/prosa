import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type Bundle,
  type BundleManifest,
  closeBundle,
  defaultBundlePath,
  openBundle,
} from '../core/bundle.js';
import { decompressBytes } from '../core/cas/compress.js';
import { blake3Hex } from '../core/cas/hash.js';
import { getErrorMessage } from '../core/errors.js';
import { currentSchemaVersion } from '../core/schema/migrate.js';
import { PROSA_PARSER_VERSION, PROSA_SCHEMA_VERSION } from '../core/version.js';
import {
  type SearchIndexStatus,
  countFts5Docs,
  countSearchDocs,
  getCurrentTantivySchemaFingerprint,
  getSearchIndexStatuses,
  tantivyIndexDirIsValid,
} from './indexing.js';

export type CheckStatus = 'pass' | 'info' | 'warn' | 'fail' | 'skipped';

export interface CheckResult {
  check: string;
  status: CheckStatus;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  storePath: string;
  bundleOpened: boolean;
  checks: CheckResult[];
  summary: {
    pass: number;
    info: number;
    warn: number;
    fail: number;
    skipped: number;
    duration_ms: number;
  };
}

export interface DoctorOptions {
  storePath?: string;
  deep?: boolean;
  deepSample?: number;
  /** Dotted prefixes or exact check names to include. Empty/undefined = all. */
  checks?: string[];
}

const VACUUM_THRESHOLD_PCT = 10;
const WAL_WARN_BYTES = 256 * 1024 * 1024;
const STUCK_BATCH_AGE_HOURS = 1;
const RECENT_BATCHES_FOR_ERRORS = 3;
const DEFAULT_DEEP_SAMPLE = 100;

/**
 * Return true when freelist waste crosses the vacuum-recommendation threshold.
 * Pure so the threshold logic is unit-testable without a fixture bundle.
 */
export function shouldRecommendVacuum(
  freelistCount: number,
  pageCount: number,
  thresholdPct = VACUUM_THRESHOLD_PCT,
): boolean {
  if (pageCount <= 0) return false;
  const pct = (freelistCount / pageCount) * 100;
  return pct > thresholdPct;
}

/**
 * Audit a bundle's health. Tolerates open failures: when `openBundle` throws
 * (missing manifest, schema mismatch, corrupt sqlite), doctor still produces
 * a report — the bundle-layout / schema checks fire and the rest are marked
 * `skipped`. Doctor never throws on bundle problems; only catastrophic errors
 * inside the check engine propagate.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const storePath = path.resolve(opts.storePath ?? defaultBundlePath());
  const deep = opts.deep === true;
  const deepSample = Math.max(1, opts.deepSample ?? DEFAULT_DEEP_SAMPLE);
  const filters = opts.checks?.filter((c) => c.length > 0) ?? [];

  const started = Date.now();
  const results: CheckResult[] = [];

  const push = (result: CheckResult): void => {
    if (filters.length === 0 || matchesFilter(result.check, filters)) {
      results.push(result);
    }
  };

  // Phase 1: layout checks that don't need an open bundle.
  const layout = await checkBundleLayout(storePath);
  for (const r of layout.results) push(r);

  // Phase 2: try to open the bundle. If it fails, surface as a fail check and
  // skip the SQLite/search/data checks.
  let bundle: Bundle | null = null;
  let openError: Error | null = null;
  if (layout.canOpen) {
    try {
      bundle = await openBundle(storePath);
    } catch (err) {
      openError = err as Error;
    }
  }

  if (openError) {
    push({
      check: 'bundle.open',
      status: 'fail',
      message: `openBundle failed: ${getErrorMessage(openError)}`,
      hint: 'fix the bundle layout or schema, then re-run doctor',
      details: { error: getErrorMessage(openError) },
    });
  } else if (!layout.canOpen) {
    push({
      check: 'bundle.open',
      status: 'skipped',
      message: 'bundle layout checks failed; not attempting to open',
    });
  } else if (bundle) {
    push({
      check: 'bundle.open',
      status: 'pass',
      message: `bundle opened at ${storePath}`,
    });
  }

  if (bundle) {
    try {
      // Schema triangulation.
      const schemaResults = checkSchema(bundle);
      for (const r of schemaResults) push(r);

      // SQLite-level health.
      for (const r of checkSqliteHealth(bundle)) push(r);
      const walResult = await checkWalSize(bundle);
      push(walResult);

      // Search index status + tantivy validity + drift.
      const liveCount = countSearchDocs(bundle);
      const liveFts5 = countFts5Docs(bundle);
      const statuses = getSearchIndexStatuses(bundle);
      for (const r of checkSearchIndexes(bundle, statuses, liveCount, liveFts5)) push(r);

      // Import errors + stuck batches.
      for (const r of checkImports(bundle)) push(r);

      // Data sanity.
      for (const r of checkData(bundle)) push(r);

      // Deep checks (opt-in).
      if (deep) {
        push(checkIntegrityFull(bundle));
        for (const r of await checkCasSample(bundle, deepSample)) push(r);
      } else {
        push({
          check: 'deep',
          status: 'skipped',
          message: 'run with --deep to include integrity_check and CAS hash sampling',
        });
      }
    } finally {
      closeBundle(bundle);
    }
  }

  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    info: results.filter((r) => r.status === 'info').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    duration_ms: Date.now() - started,
  };

  return {
    storePath,
    bundleOpened: bundle !== null,
    checks: results,
    summary,
  };
}

function matchesFilter(check: string, filters: string[]): boolean {
  return filters.some((f) => check === f || check.startsWith(`${f}.`));
}

// -- Phase 1: layout checks (run without a Bundle) ---------------------------

interface LayoutResult {
  results: CheckResult[];
  canOpen: boolean;
}

async function checkBundleLayout(storePath: string): Promise<LayoutResult> {
  const results: CheckResult[] = [];
  let manifestParsed: BundleManifest | null = null;

  const dirStat = await stat(storePath).catch(() => null);
  if (!dirStat?.isDirectory()) {
    results.push({
      check: 'bundle.dir',
      status: 'fail',
      message: `${storePath} is not a directory`,
      hint: `prosa init --store ${storePath}`,
    });
    return { results, canOpen: false };
  }
  results.push({
    check: 'bundle.dir',
    status: 'pass',
    message: `bundle directory present at ${storePath}`,
  });

  const manifestPath = path.join(storePath, 'manifest.json');
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifestParsed = JSON.parse(raw) as BundleManifest;
    const requiredFields: (keyof BundleManifest)[] = [
      'version',
      'parser_version',
      'schema_version',
      'created_at',
      'hash_alg',
      'default_compression',
    ];
    const missing = requiredFields.filter((f) => manifestParsed?.[f] == null);
    if (missing.length > 0) {
      results.push({
        check: 'bundle.manifest',
        status: 'fail',
        message: `manifest.json missing required fields: ${missing.join(', ')}`,
        details: { missing },
      });
      return { results, canOpen: false };
    }
    results.push({
      check: 'bundle.manifest',
      status: 'pass',
      message: `manifest.json valid (version=${manifestParsed.version}, schema_version=${manifestParsed.schema_version})`,
      details: { manifest: manifestParsed as unknown as Record<string, unknown> },
    });
  } catch (err) {
    results.push({
      check: 'bundle.manifest',
      status: 'fail',
      message: `manifest.json not readable: ${getErrorMessage(err)}`,
      hint: `prosa init --store ${storePath}`,
    });
    return { results, canOpen: false };
  }

  // sqlite file.
  const dbPath = path.join(storePath, 'prosa.sqlite');
  const dbStat = await stat(dbPath).catch(() => null);
  if (!dbStat?.isFile() || dbStat.size === 0) {
    results.push({
      check: 'bundle.sqlite',
      status: 'fail',
      message: 'prosa.sqlite missing or empty',
      hint: `prosa init --store ${storePath}`,
    });
    return { results, canOpen: false };
  }
  results.push({
    check: 'bundle.sqlite',
    status: 'pass',
    message: `prosa.sqlite present (${formatBytes(dbStat.size)})`,
    details: { size_bytes: dbStat.size },
  });

  // Required sidecar directories.
  const requiredDirs: { key: string; rel: string }[] = [
    { key: 'objects', rel: 'objects' },
    { key: 'rawSources', rel: 'raw/sources' },
    { key: 'search', rel: 'search' },
    { key: 'tantivy', rel: 'search/tantivy' },
    { key: 'exports', rel: 'exports' },
    { key: 'parquet', rel: 'parquet' },
  ];
  const missingDirs: string[] = [];
  for (const d of requiredDirs) {
    const s = await stat(path.join(storePath, d.rel)).catch(() => null);
    if (!s?.isDirectory()) missingDirs.push(d.rel);
  }
  if (missingDirs.length > 0) {
    results.push({
      check: 'bundle.dirs',
      status: 'warn',
      message: `missing sidecar directories: ${missingDirs.join(', ')}`,
      hint: 'openBundle recreates search/ and search/tantivy/ on next open; others come from init',
      details: { missing: missingDirs },
    });
  } else {
    results.push({
      check: 'bundle.dirs',
      status: 'pass',
      message: 'all sidecar directories present',
    });
  }

  // Format guards.
  if (manifestParsed.hash_alg !== 'blake3') {
    results.push({
      check: 'bundle.format',
      status: 'fail',
      message: `unexpected hash_alg=${manifestParsed.hash_alg}; expected blake3`,
    });
  } else if (manifestParsed.default_compression !== 'zstd') {
    results.push({
      check: 'bundle.format',
      status: 'warn',
      message: `default_compression=${manifestParsed.default_compression}; expected zstd`,
    });
  } else {
    results.push({
      check: 'bundle.format',
      status: 'pass',
      message: 'hash_alg=blake3, default_compression=zstd',
    });
  }

  return { results, canOpen: true };
}

// -- Phase 2: checks with an open Bundle -------------------------------------

function checkSchema(bundle: Bundle): CheckResult[] {
  const results: CheckResult[] = [];
  const dbVersion = currentSchemaVersion(bundle.db);
  const manifestVersion = bundle.manifest.schema_version;
  const details = { manifest: manifestVersion, db: dbVersion, code: PROSA_SCHEMA_VERSION };

  // openBundle already enforces db === code, so by the time we run we know
  // they agree. The remaining axis is the manifest, which is written once at
  // init and currently never updated by migrations.
  if (dbVersion !== PROSA_SCHEMA_VERSION) {
    results.push({
      check: 'schema.version',
      status: 'fail',
      message: `db schema_version=${dbVersion} but code expects ${PROSA_SCHEMA_VERSION}`,
      hint: 'upgrade or downgrade prosa to match the bundle, or re-run any command to apply pending migrations',
      details,
    });
  } else if (manifestVersion !== dbVersion) {
    results.push({
      check: 'schema.version',
      status: 'warn',
      message: `manifest.schema_version=${manifestVersion} but db has migrated to ${dbVersion}`,
      hint: 'manifest is stale after a migration; safe to ignore or refresh manually',
      details,
    });
  } else {
    results.push({
      check: 'schema.version',
      status: 'pass',
      message: `schema_version=${PROSA_SCHEMA_VERSION} (manifest, db, code agree)`,
    });
  }

  if (bundle.manifest.parser_version === PROSA_PARSER_VERSION) {
    results.push({
      check: 'schema.parser_version',
      status: 'pass',
      message: `parser_version=${PROSA_PARSER_VERSION}`,
    });
  } else {
    results.push({
      check: 'schema.parser_version',
      status: 'info',
      message: `manifest.parser_version=${bundle.manifest.parser_version} != code ${PROSA_PARSER_VERSION} (will be refreshed on next openBundle)`,
    });
  }

  return results;
}

function checkSqliteHealth(bundle: Bundle): CheckResult[] {
  const results: CheckResult[] = [];

  // PRAGMA quick_check returns rows with the column named 'quick_check' — read by index.
  const quickRows = bundle.db.prepare(`PRAGMA quick_check`).all() as Array<Record<string, unknown>>;
  const quickValue = quickRows[0] ? Object.values(quickRows[0])[0] : null;
  if (quickValue === 'ok') {
    results.push({ check: 'sqlite.quick_check', status: 'pass', message: 'quick_check=ok' });
  } else {
    results.push({
      check: 'sqlite.quick_check',
      status: 'fail',
      message: `quick_check returned ${String(quickValue)}`,
      hint: 'run with --deep for full integrity_check, or restore from backup',
      details: { rows: quickRows },
    });
  }

  const fkRows = bundle.db.prepare(`PRAGMA foreign_key_check`).all() as Array<
    Record<string, unknown>
  >;
  if (fkRows.length === 0) {
    results.push({
      check: 'sqlite.foreign_keys',
      status: 'pass',
      message: 'no foreign key violations',
    });
  } else {
    results.push({
      check: 'sqlite.foreign_keys',
      status: 'fail',
      message: `${fkRows.length} foreign key violation(s)`,
      details: { violations: fkRows.slice(0, 5) },
    });
  }

  const journalMode = (
    bundle.db.prepare(`PRAGMA journal_mode`).get() as { journal_mode?: string } | undefined
  )?.journal_mode;
  if (journalMode === 'wal') {
    results.push({ check: 'sqlite.journal_mode', status: 'pass', message: 'journal_mode=wal' });
  } else {
    results.push({
      check: 'sqlite.journal_mode',
      status: 'warn',
      message: `journal_mode=${journalMode ?? 'unknown'}; expected wal`,
    });
  }

  const pageSize =
    (bundle.db.prepare(`PRAGMA page_size`).get() as { page_size?: number } | undefined)
      ?.page_size ?? 0;
  if (pageSize === 16384) {
    results.push({ check: 'sqlite.page_size', status: 'pass', message: 'page_size=16384' });
  } else {
    results.push({
      check: 'sqlite.page_size',
      status: 'warn',
      message: `page_size=${pageSize}; current openDb expects 16384`,
      hint: `migrate with: sqlite3 prosa.sqlite "PRAGMA page_size=16384; VACUUM INTO 'prosa16k.sqlite';" and swap files`,
      details: { page_size: pageSize },
    });
  }

  const pageCount =
    (bundle.db.prepare(`PRAGMA page_count`).get() as { page_count?: number } | undefined)
      ?.page_count ?? 0;
  const freelistCount =
    (bundle.db.prepare(`PRAGMA freelist_count`).get() as { freelist_count?: number } | undefined)
      ?.freelist_count ?? 0;
  const pctWaste = pageCount > 0 ? (freelistCount / pageCount) * 100 : 0;
  const dbSizeBytes = pageCount * pageSize;
  if (shouldRecommendVacuum(freelistCount, pageCount)) {
    results.push({
      check: 'sqlite.vacuum_hint',
      status: 'warn',
      message: `${pctWaste.toFixed(1)}% of pages are free (${freelistCount}/${pageCount})`,
      hint: 'run VACUUM to reclaim space and defragment indexes',
      details: {
        page_count: pageCount,
        freelist_count: freelistCount,
        pct_waste: Number(pctWaste.toFixed(2)),
        db_size_bytes: dbSizeBytes,
      },
    });
  } else {
    results.push({
      check: 'sqlite.vacuum_hint',
      status: 'pass',
      message: `${pctWaste.toFixed(2)}% pages free; VACUUM not needed`,
      details: {
        page_count: pageCount,
        freelist_count: freelistCount,
        pct_waste: Number(pctWaste.toFixed(2)),
        db_size_bytes: dbSizeBytes,
      },
    });
  }

  return results;
}

async function checkWalSize(bundle: Bundle): Promise<CheckResult> {
  const walPath = `${bundle.paths.db}-wal`;
  const s = await stat(walPath).catch(() => null);
  if (!s) {
    return {
      check: 'sqlite.wal_size',
      status: 'pass',
      message: 'WAL file absent (DB closed cleanly or checkpointed)',
    };
  }
  if (s.size > WAL_WARN_BYTES) {
    return {
      check: 'sqlite.wal_size',
      status: 'warn',
      message: `WAL file is ${formatBytes(s.size)}; a long-lived read transaction is preventing checkpoint`,
      hint: `close other prosa processes, then: sqlite3 prosa.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"`,
      details: { wal_size_bytes: s.size },
    };
  }
  return {
    check: 'sqlite.wal_size',
    status: 'pass',
    message: `WAL size ${formatBytes(s.size)}`,
    details: { wal_size_bytes: s.size },
  };
}

function checkSearchIndexes(
  bundle: Bundle,
  statuses: SearchIndexStatus[],
  liveDocCount: number,
  liveFts5Count: number,
): CheckResult[] {
  const results: CheckResult[] = [];
  const byEngine = new Map(statuses.map((s) => [s.engine, s]));

  // FTS5.
  const fts5 = byEngine.get('fts5');
  if (!fts5 || fts5.status === 'missing') {
    results.push({
      check: 'search.fts5',
      status: 'warn',
      message: 'fts5 index missing',
      hint: 'prosa index fts5',
    });
  } else if (fts5.status === 'ready') {
    if (liveFts5Count !== liveDocCount) {
      results.push({
        check: 'search.fts5',
        status: 'warn',
        message: `fts5 indexed ${liveFts5Count} docs but search_docs has ${liveDocCount}`,
        hint: 'prosa index fts5',
        details: { fts5_count: liveFts5Count, source_count: liveDocCount, ...statusDetails(fts5) },
      });
    } else {
      results.push({
        check: 'search.fts5',
        status: 'pass',
        message: `fts5 ready (${liveFts5Count} docs)`,
        details: statusDetails(fts5),
      });
    }
  } else if (fts5.status === 'failed') {
    results.push({
      check: 'search.fts5',
      status: 'fail',
      message: `fts5 failed: ${fts5.error_message ?? 'unknown error'}`,
      hint: 'prosa index fts5',
      details: statusDetails(fts5),
    });
  } else {
    results.push({
      check: 'search.fts5',
      status: 'warn',
      message: `fts5 status=${fts5.status}`,
      hint: 'prosa index fts5',
      details: statusDetails(fts5),
    });
  }

  // Tantivy.
  const tantivy = byEngine.get('tantivy');
  if (!tantivy || tantivy.status === 'missing') {
    results.push({
      check: 'search.tantivy',
      status: 'info',
      message: 'tantivy index not built (optional)',
      hint: 'prosa index tantivy',
    });
  } else {
    const dirValid = tantivyIndexDirIsValid(bundle.paths.tantivy);
    const currentFingerprint = getCurrentTantivySchemaFingerprint();
    const fingerprintOk =
      tantivy.schema_fingerprint == null || tantivy.schema_fingerprint === currentFingerprint;

    if (tantivy.status === 'failed') {
      results.push({
        check: 'search.tantivy',
        status: 'fail',
        message: `tantivy failed: ${tantivy.error_message ?? 'unknown error'}`,
        hint: 'prosa index tantivy --overwrite',
        details: statusDetails(tantivy),
      });
    } else if (tantivy.status === 'ready' && !dirValid) {
      results.push({
        check: 'search.tantivy',
        status: 'fail',
        message: 'tantivy status=ready but index directory has no meta.json',
        hint: 'prosa index tantivy --overwrite',
        details: { ...statusDetails(tantivy), dir: bundle.paths.tantivy },
      });
    } else if (!fingerprintOk) {
      results.push({
        check: 'search.tantivy',
        status: 'warn',
        message: 'tantivy schema fingerprint drift; rebuild will be forced full',
        hint: 'prosa index tantivy --overwrite',
        details: {
          stored: tantivy.schema_fingerprint,
          current: currentFingerprint,
          ...statusDetails(tantivy),
        },
      });
    } else if (tantivy.status === 'ready') {
      results.push({
        check: 'search.tantivy',
        status: 'pass',
        message: `tantivy ready (${tantivy.indexed_doc_count} docs)`,
        details: statusDetails(tantivy),
      });
    } else {
      results.push({
        check: 'search.tantivy',
        status: 'warn',
        message: `tantivy status=${tantivy.status}`,
        hint: 'prosa index tantivy',
        details: statusDetails(tantivy),
      });
    }
  }

  // Drift between live search_docs and what indexes recorded.
  const drift = statuses
    .filter((s) => s.status === 'ready')
    .map((s) => ({
      engine: s.engine,
      stored: s.source_doc_count,
      live: liveDocCount,
      diff: liveDocCount - s.source_doc_count,
    }))
    .filter((d) => d.diff !== 0);
  if (drift.length > 0) {
    results.push({
      check: 'search.drift',
      status: 'warn',
      message: `search_docs count drifted from recorded source_doc_count: ${drift
        .map((d) => `${d.engine} off by ${d.diff}`)
        .join('; ')}`,
      hint: 'prosa index <engine> for each affected engine',
      details: { drift },
    });
  } else {
    results.push({
      check: 'search.drift',
      status: 'pass',
      message: `search_docs (${liveDocCount}) matches recorded source counts`,
    });
  }

  return results;
}

function statusDetails(s: SearchIndexStatus): Record<string, unknown> {
  return {
    engine: s.engine,
    status: s.status,
    source_doc_count: s.source_doc_count,
    indexed_doc_count: s.indexed_doc_count,
    updated_at: s.updated_at,
  };
}

function checkImports(bundle: Bundle): CheckResult[] {
  const results: CheckResult[] = [];

  const stuckRows = bundle.db
    .prepare(
      `SELECT batch_id, started_at, source_tool, status FROM import_batches
        WHERE finished_at IS NULL
          AND (julianday('now') - julianday(started_at)) * 24 > ?`,
    )
    .all(STUCK_BATCH_AGE_HOURS) as Array<Record<string, unknown>>;
  if (stuckRows.length > 0) {
    results.push({
      check: 'import_batches.stuck',
      status: 'warn',
      message: `${stuckRows.length} unfinished import batch(es) older than ${STUCK_BATCH_AGE_HOURS}h`,
      hint: 'a previous compile crashed; re-run prosa compile or compile-all',
      details: { batches: stuckRows },
    });
  } else {
    results.push({
      check: 'import_batches.stuck',
      status: 'pass',
      message: 'no stuck import batches',
    });
  }

  // Errors in the most recent N batches.
  const recentErrors = bundle.db
    .prepare(
      `WITH recent AS (
         SELECT batch_id FROM import_batches ORDER BY started_at DESC LIMIT ?
       )
       SELECT kind, COUNT(*) AS n
         FROM import_errors
        WHERE batch_id IN (SELECT batch_id FROM recent)
        GROUP BY kind
        ORDER BY n DESC`,
    )
    .all(RECENT_BATCHES_FOR_ERRORS) as Array<{ kind: string; n: number }>;

  const recentSamples = bundle.db
    .prepare(
      `WITH recent AS (
         SELECT batch_id FROM import_batches ORDER BY started_at DESC LIMIT ?
       )
       SELECT kind, message, occurred_at
         FROM import_errors
        WHERE batch_id IN (SELECT batch_id FROM recent)
        ORDER BY occurred_at DESC
        LIMIT 3`,
    )
    .all(RECENT_BATCHES_FOR_ERRORS) as Array<Record<string, unknown>>;

  const totalRecent = recentErrors.reduce((s, r) => s + r.n, 0);
  if (totalRecent > 0) {
    results.push({
      check: 'import_errors.recent',
      status: 'warn',
      message: `${totalRecent} error(s) across the last ${RECENT_BATCHES_FOR_ERRORS} import batch(es)`,
      hint: 'inspect import_errors or re-run the affected compile with --verbose',
      details: { by_kind: recentErrors, samples: recentSamples },
    });
  } else {
    results.push({
      check: 'import_errors.recent',
      status: 'pass',
      message: `no errors in the last ${RECENT_BATCHES_FOR_ERRORS} import batch(es)`,
    });
  }

  return results;
}

function checkData(bundle: Bundle): CheckResult[] {
  const results: CheckResult[] = [];

  const counts = bundle.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions)     AS sessions,
         (SELECT COUNT(*) FROM messages)     AS messages,
         (SELECT COUNT(*) FROM raw_records)  AS raw_records,
         (SELECT COUNT(*) FROM objects)      AS objects`,
    )
    .get() as { sessions: number; messages: number; raw_records: number; objects: number };

  if (counts.sessions === 0) {
    results.push({
      check: 'data.counts',
      status: 'info',
      message: 'bundle is empty (no sessions imported yet)',
      details: counts,
    });
  } else if (counts.messages === 0) {
    results.push({
      check: 'data.counts',
      status: 'fail',
      message: `${counts.sessions} session(s) but 0 messages — import likely broke mid-file`,
      hint: 'inspect import_errors and re-run prosa compile-all',
      details: counts,
    });
  } else {
    results.push({
      check: 'data.counts',
      status: 'pass',
      message: `sessions=${counts.sessions}, messages=${counts.messages}, raw_records=${counts.raw_records}, objects=${counts.objects}`,
      details: counts,
    });
  }

  // Subagent edges pointing at sessions that don't exist (info-only).
  const orphanSubagents = bundle.db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM edges e
        WHERE e.edge_type = 'spawned'
          AND e.dst_type = 'session'
          AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = e.dst_id)`,
    )
    .get() as { n: number };
  if (orphanSubagents.n > 0) {
    results.push({
      check: 'data.subagents',
      status: 'info',
      message: `${orphanSubagents.n} spawned-edge(s) point to sessions not in the bundle (subagent files not yet imported)`,
      details: { count: orphanSubagents.n },
    });
  } else {
    results.push({
      check: 'data.subagents',
      status: 'pass',
      message: 'no orphan subagent edges',
    });
  }

  return results;
}

// -- Deep checks -------------------------------------------------------------

function checkIntegrityFull(bundle: Bundle): CheckResult {
  const rows = bundle.db.prepare(`PRAGMA integrity_check`).all() as Array<Record<string, unknown>>;
  const first = rows[0] ? Object.values(rows[0])[0] : null;
  if (rows.length === 1 && first === 'ok') {
    return {
      check: 'deep.integrity_check',
      status: 'pass',
      message: 'integrity_check=ok',
    };
  }
  return {
    check: 'deep.integrity_check',
    status: 'fail',
    message: `integrity_check returned ${rows.length} issue(s)`,
    details: { issues: rows.slice(0, 20) },
  };
}

interface CasSampleRow {
  object_id: string;
  hash: string;
  compression: 'zstd' | 'none';
  storage_path: string;
  size_bytes: number;
}

async function checkCasSample(bundle: Bundle, sampleSize: number): Promise<CheckResult[]> {
  const rows = bundle.db
    .prepare(
      `SELECT object_id, hash, compression, storage_path, size_bytes
         FROM objects
        ORDER BY random()
        LIMIT ?`,
    )
    .all(sampleSize) as CasSampleRow[];

  if (rows.length === 0) {
    return [
      {
        check: 'deep.cas_file_exists',
        status: 'info',
        message: 'objects table empty; nothing to sample',
      },
      {
        check: 'deep.cas_hash_sample',
        status: 'info',
        message: 'objects table empty; nothing to sample',
      },
    ];
  }

  const missing: string[] = [];
  const hashMismatches: string[] = [];
  const readErrors: string[] = [];
  let checked = 0;

  // Rows in `objects` can live under either `objects/blake3/.../<hash>.<ext>`
  // (the CAS layout used by stage*/flushPendingObjects) or `raw/sources/<hash>.<ext>`
  // (source files registered by registerSourceFile). The on-disk path is always
  // stored verbatim in `storage_path` — trust that column rather than recomputing.
  for (const row of rows) {
    const abs = path.join(bundle.path, row.storage_path);
    try {
      await access(abs);
    } catch {
      missing.push(row.object_id);
      continue;
    }
    try {
      const compressed = await readFile(abs);
      const plain = decompressBytes(compressed, row.compression);
      const recomputed = `blake3:${blake3Hex(plain)}`;
      if (recomputed !== row.object_id) {
        hashMismatches.push(`${row.object_id} (file decodes to ${recomputed})`);
      }
      checked++;
    } catch (err) {
      readErrors.push(`${row.object_id}: ${getErrorMessage(err)}`);
    }
  }

  const results: CheckResult[] = [];
  if (missing.length === 0) {
    results.push({
      check: 'deep.cas_file_exists',
      status: 'pass',
      message: `all ${rows.length} sampled objects have files on disk`,
    });
  } else {
    results.push({
      check: 'deep.cas_file_exists',
      status: 'fail',
      message: `${missing.length}/${rows.length} sampled objects have missing files`,
      hint: 'CAS files were deleted outside prosa; re-import the affected source files',
      details: { missing: missing.slice(0, 10) },
    });
  }

  if (hashMismatches.length === 0 && readErrors.length === 0) {
    results.push({
      check: 'deep.cas_hash_sample',
      status: 'pass',
      message: `re-hashed ${checked} sampled object(s); all match`,
    });
  } else if (hashMismatches.length > 0) {
    results.push({
      check: 'deep.cas_hash_sample',
      status: 'fail',
      message: `${hashMismatches.length} hash mismatch(es) in ${rows.length} sampled object(s)`,
      hint: 'silent corruption on disk; restore from backup',
      details: {
        mismatches: hashMismatches.slice(0, 10),
        read_errors: readErrors.slice(0, 5),
      },
    });
  } else {
    results.push({
      check: 'deep.cas_hash_sample',
      status: 'warn',
      message: `${readErrors.length} read error(s) while sampling CAS objects`,
      details: { read_errors: readErrors.slice(0, 10) },
    });
  }

  return results;
}

// -- Helpers -----------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
