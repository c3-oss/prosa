import { mkdtemp, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type BundleManifest, closeBundle, initBundle } from '../../src/core/bundle.js'
import { compileCodex } from '../../src/importers/codex/index.js'
import { type CheckResult, runDoctor, shouldRecommendVacuum } from '../../src/services/doctor.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CODEX_FIXTURES = path.resolve(__dirname, '../fixtures/codex')

interface TempPath {
  path: string
  cleanup: () => Promise<void>
}

async function makeTempStore(): Promise<TempPath> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prosa-doctor-test-'))
  return {
    path: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function check(report: { checks: CheckResult[] }, name: string): CheckResult | undefined {
  return report.checks.find((c) => c.check === name)
}

describe('doctor — shouldRecommendVacuum', () => {
  it('returns false when freelist is empty', () => {
    expect(shouldRecommendVacuum(0, 1000)).toBe(false)
  })

  it('returns false at the threshold', () => {
    expect(shouldRecommendVacuum(100, 1000, 10)).toBe(false)
  })

  it('returns true above the threshold', () => {
    expect(shouldRecommendVacuum(101, 1000, 10)).toBe(true)
  })

  it('returns false on an empty database', () => {
    expect(shouldRecommendVacuum(0, 0)).toBe(false)
  })
})

describe('doctor — happy path on an empty bundle', () => {
  it('opens the bundle and reports an info on data.counts (no sessions)', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path })

      expect(report.bundleOpened).toBe(true)
      expect(check(report, 'bundle.dir')?.status).toBe('pass')
      expect(check(report, 'bundle.manifest')?.status).toBe('pass')
      expect(check(report, 'bundle.sqlite')?.status).toBe('pass')
      expect(check(report, 'bundle.dirs')?.status).toBe('pass')
      expect(check(report, 'schema.version')?.status).toBe('pass')
      expect(check(report, 'sqlite.quick_check')?.status).toBe('pass')
      expect(check(report, 'sqlite.foreign_keys')?.status).toBe('pass')
      expect(check(report, 'sqlite.page_size')?.status).toBe('pass')
      expect(check(report, 'sqlite.vacuum_hint')?.status).toBe('pass')
      expect(check(report, 'data.counts')?.status).toBe('info')
      expect(report.summary.fail).toBe(0)
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — happy path with imported data', () => {
  it('passes data.counts and data.subagents after a codex compile', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      await compileCodex(bundle, CODEX_FIXTURES)
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path })

      expect(check(report, 'data.counts')?.status).toBe('pass')
      const details = check(report, 'data.counts')?.details as { sessions: number }
      expect(details.sessions).toBeGreaterThan(0)
      expect(report.summary.fail).toBe(0)
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — layout failures', () => {
  it('reports fail on bundle.manifest when manifest.json is missing', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      closeBundle(bundle)
      await unlink(path.join(t.path, 'manifest.json'))

      const report = await runDoctor({ storePath: t.path })

      expect(report.bundleOpened).toBe(false)
      expect(check(report, 'bundle.manifest')?.status).toBe('fail')
      // SQLite-level checks must not have run.
      expect(check(report, 'sqlite.quick_check')).toBeUndefined()
    } finally {
      await t.cleanup()
    }
  })

  it('reports fail on bundle.dir when the path is not a directory', async () => {
    const t = await makeTempStore()
    try {
      // Replace the directory with a regular file.
      await rm(t.path, { recursive: true, force: true })
      await writeFile(t.path, 'not a bundle')

      const report = await runDoctor({ storePath: t.path })

      expect(check(report, 'bundle.dir')?.status).toBe('fail')
      expect(report.bundleOpened).toBe(false)
    } finally {
      await unlink(t.path).catch(() => {})
    }
  })
})

describe('doctor — search drift', () => {
  it('warns when search_docs has more rows than recorded in source_doc_count', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      await compileCodex(bundle, CODEX_FIXTURES)
      // Inject an extra search_docs row without updating search_index_status.
      bundle.db
        .prepare(
          `INSERT INTO search_docs (doc_id, entity_type, entity_id, session_id, project_id,
             timestamp, role, tool_name, canonical_tool_type, field_kind, text)
           VALUES ('doctor-test-extra', 'message', 'doctor-test-extra', NULL, NULL,
             NULL, NULL, NULL, NULL, 'assistant_text', 'extra row from test')`,
        )
        .run()
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path })
      const drift = check(report, 'search.drift')
      expect(drift?.status).toBe('warn')
      expect(drift?.message).toContain('drifted')
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — import_batches.stuck', () => {
  it('warns when an unfinished batch is older than the threshold', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      bundle.db
        .prepare(
          `INSERT INTO import_batches (batch_id, parser_version, source_tool, paths, started_at, finished_at, status)
           VALUES ('stale-batch', '0.0.0', 'codex', '[]', datetime('now', '-2 hours'), NULL, 'running')`,
        )
        .run()
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path })
      const stuck = check(report, 'import_batches.stuck')
      expect(stuck?.status).toBe('warn')
      const details = stuck?.details as { batches: Array<{ batch_id: string }> }
      expect(details.batches[0]?.batch_id).toBe('stale-batch')
    } finally {
      await t.cleanup()
    }
  })

  it('passes when the only stale batch is freshly started', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      bundle.db
        .prepare(
          `INSERT INTO import_batches (batch_id, parser_version, source_tool, paths, started_at, finished_at, status)
           VALUES ('fresh-batch', '0.0.0', 'codex', '[]', datetime('now'), NULL, 'running')`,
        )
        .run()
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path })
      expect(check(report, 'import_batches.stuck')?.status).toBe('pass')
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — import_errors.recent', () => {
  it('warns when a recent batch has errors', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      bundle.db
        .prepare(
          `INSERT INTO import_batches (batch_id, parser_version, source_tool, paths, started_at, finished_at, status)
           VALUES ('batch-with-errors', '0.0.0', 'codex', '[]', datetime('now'), datetime('now'), 'completed')`,
        )
        .run()
      bundle.db
        .prepare(
          `INSERT INTO import_errors (batch_id, kind, message, occurred_at)
           VALUES ('batch-with-errors', 'codex_file_failed', 'parse error on line 7', datetime('now'))`,
        )
        .run()
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path })
      const errors = check(report, 'import_errors.recent')
      expect(errors?.status).toBe('warn')
      const details = errors?.details as { by_kind: Array<{ kind: string; n: number }> }
      expect(details.by_kind[0]?.kind).toBe('codex_file_failed')
      expect(details.by_kind[0]?.n).toBe(1)
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — deep CAS checks', () => {
  it('detects file truncation as a hash mismatch', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      await compileCodex(bundle, CODEX_FIXTURES)

      // Pick one object whose file we can corrupt.
      const obj = bundle.db
        .prepare(`SELECT object_id, storage_path FROM objects WHERE size_bytes > 32 ORDER BY size_bytes LIMIT 1`)
        .get() as { object_id: string; storage_path: string }
      expect(obj).toBeTruthy()
      closeBundle(bundle)

      // Truncate the file on disk so blake3 of decompressed bytes won't match.
      await truncate(path.join(t.path, obj.storage_path), 4)

      const report = await runDoctor({ storePath: t.path, deep: true, deepSample: 200 })
      // Truncation may surface as a hash mismatch or a read error during
      // decompression — either way deep.cas_hash_sample must not pass.
      const hashCheck = check(report, 'deep.cas_hash_sample')
      expect(hashCheck?.status === 'fail' || hashCheck?.status === 'warn').toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('passes deep checks on a clean bundle', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      await compileCodex(bundle, CODEX_FIXTURES)
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path, deep: true, deepSample: 10 })
      expect(check(report, 'deep.integrity_check')?.status).toBe('pass')
      expect(check(report, 'deep.cas_file_exists')?.status).toBe('pass')
      expect(check(report, 'deep.cas_hash_sample')?.status).toBe('pass')
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — filtering', () => {
  it('only runs checks matching --checks prefixes', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      closeBundle(bundle)

      const report = await runDoctor({ storePath: t.path, checks: ['sqlite'] })
      // Every emitted check must start with `sqlite.`
      for (const c of report.checks) {
        expect(c.check.startsWith('sqlite.')).toBe(true)
      }
    } finally {
      await t.cleanup()
    }
  })
})

describe('doctor — manifest refresh smoke', () => {
  it('writes the migrated schema_version back to manifest on open', async () => {
    const t = await makeTempStore()
    try {
      const bundle = await initBundle(t.path)
      closeBundle(bundle)

      // Tamper with the manifest to simulate an old bundle that pre-dates the
      // current schema version.
      const manifestPath = path.join(t.path, 'manifest.json')
      const original = JSON.parse(await readFile(manifestPath, 'utf8')) as BundleManifest
      const tampered = { ...original, schema_version: 1 }
      await writeFile(manifestPath, JSON.stringify(tampered, null, 2))

      // runDoctor opens via openBundle, which refreshes manifest.schema_version.
      const report = await runDoctor({ storePath: t.path })
      expect(check(report, 'schema.version')?.status).toBe('pass')

      const after = JSON.parse(await readFile(manifestPath, 'utf8')) as BundleManifest
      expect(after.schema_version).toBe(original.schema_version)
    } finally {
      await t.cleanup()
    }
  })
})
