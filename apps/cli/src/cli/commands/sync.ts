import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { type Bundle, closeBundle, defaultBundlePath, openBundle } from '@c3-oss/prosa-core'
import type { ProjectionPayload, ProjectionSessionRow, SearchDocRow } from '@c3-oss/prosa-sync'
import { Command } from 'commander'
import { ProsaApiClient } from '../auth/client.js'
import {
  type ProsaServerEntry,
  activeEntry,
  defaultConfigPath,
  isPromoted,
  loadCliConfig,
  recordPromotion,
  saveCliConfig,
  upsertServer,
} from '../auth/config.js'
import { CliUserError } from '../errors.js'

type SyncOptions = {
  server?: string
  tenant?: string
  store?: string
  dryRun?: boolean
  keepLocal?: boolean
  purgeBundle?: boolean
  json?: boolean
  verbose?: boolean
  configPath?: string
}

function readSessionsForUpload(bundle: Bundle): { sessions: ProjectionSessionRow[] } {
  const rows = bundle.db
    .prepare(
      `SELECT s.session_id, s.source_tool, s.project_id, s.title, s.start_ts, s.end_ts,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) AS turn_count
         FROM sessions s
         ORDER BY s.session_id
         LIMIT 5000`,
    )
    .all() as Array<{
    session_id: string
    source_tool: string
    project_id: string | null
    title: string | null
    start_ts: string | null
    end_ts: string | null
    turn_count: number
  }>
  return {
    sessions: rows.map((row) => ({
      id: row.session_id,
      sourceKind: row.source_tool,
      projectId: row.project_id,
      title: row.title,
      startedAt: row.start_ts,
      endedAt: row.end_ts,
      turnCount: row.turn_count,
    })),
  }
}

function readSearchDocsForUpload(bundle: Bundle): SearchDocRow[] {
  try {
    const rows = bundle.db
      .prepare(`SELECT doc_id, session_id, kind, body FROM search_docs ORDER BY doc_id LIMIT 5000`)
      .all() as Array<{ doc_id: string; session_id: string; kind: string; body: string }>
    return rows.map((row) => ({
      id: row.doc_id,
      sessionId: row.session_id,
      kind: row.kind,
      body: row.body,
    }))
  } catch {
    return []
  }
}

/**
 * Cleanup model:
 *  - Default cleanup removes only DERIVED artifacts that can be regenerated
 *    from canonical source (or from the server after promotion).
 *  - `--purge-bundle` opts into removing the canonical raw/CAS data and the
 *    manifest. This is destructive: it should only be run AFTER the raw/CAS
 *    upload path (deferred) is implemented and verified, or when the user
 *    explicitly accepts that uncommitted source bytes will be lost.
 *
 * Until the raw + CAS upload path is wired through the CLI, the default
 * cleanup preserves `objects/`, `raw/`, `prosa.sqlite`, and `manifest.json`
 * to prevent silent data loss. The store is still marked
 * remote-authoritative via the promotion receipt, so reads route to the
 * server.
 */
const DERIVED_PATHS_TO_REMOVE = ['search', 'parquet', 'exports']
const CANONICAL_PATHS_TO_REMOVE = ['prosa.sqlite', 'manifest.json', 'objects', 'raw']

async function removeLocalBundle(storePath: string, purge: boolean): Promise<string[]> {
  const entries = purge ? [...DERIVED_PATHS_TO_REMOVE, ...CANONICAL_PATHS_TO_REMOVE] : DERIVED_PATHS_TO_REMOVE
  const removed: string[] = []
  for (const entry of entries) {
    const target = path.join(storePath, entry)
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      // ignore — best-effort cleanup; cleanup retries on next command
    }
  }
  return removed
}

export function syncCommand(): Command {
  const cmd = new Command('sync')
    .description(
      'Promote a local prosa bundle to the remote server. After successful verification ' +
        'derived artifacts (search/, parquet/, exports/) are removed by default; ' +
        'use --purge-bundle to also remove the canonical raw/CAS data, and ' +
        '--keep-local to skip cleanup entirely.',
    )
    .option('--server <url>', 'override the active server URL')
    .option('--tenant <id-or-slug>', 'override the active tenant')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--dry-run', 'plan only; do not upload bytes or modify state', false)
    .option('--keep-local', 'skip cleanup entirely (still marks remote-authoritative)', false)
    .option(
      '--purge-bundle',
      'also remove canonical raw/CAS data (objects/, raw/, prosa.sqlite, manifest.json). ' +
        'Until raw/CAS upload is wired through the CLI, this is destructive and should only ' +
        'be used after you have manually confirmed the upload included raw + CAS bytes.',
      false,
    )
    .option('--json', 'machine-readable JSON output', false)
    .option('--verbose', 'extra logging', false)
    .option('--config <path>', 'override CLI config path')
    .action(async (options: SyncOptions) => {
      const configPath = options.configPath ?? defaultConfigPath()
      const config = await loadCliConfig(configPath)
      const baseEntry = activeEntry(config)
      const server = options.server ?? baseEntry?.url
      if (!server) throw new CliUserError('no active server. Run `prosa auth login` first.')
      const entry: ProsaServerEntry =
        (baseEntry && baseEntry.url === server) || baseEntry == null ? (baseEntry ?? { url: server }) : { url: server }
      if (!entry.token) throw new CliUserError('not logged in. Run `prosa auth login`.')
      const tenantHint = options.tenant ?? entry.activeTenant?.id
      if (!tenantHint) {
        throw new CliUserError('no active tenant. Run `prosa auth use <tenant>` first.')
      }

      const client = new ProsaApiClient({ baseUrl: server, token: entry.token, tenantId: tenantHint })

      const storePath = path.resolve(options.store ?? defaultBundlePath())
      const exists = await stat(`${storePath}/manifest.json`).then(
        () => true,
        () => false,
      )
      if (!exists) throw new CliUserError(`no prosa bundle at ${storePath}`)

      const bundle = await openBundle(storePath)
      let result: {
        batchId: string
        sessionCount: number
        objectCount: number
        searchDocCount: number
      }
      try {
        const handshake = await client.syncHandshake({
          cliVersion: process.env.npm_package_version ?? '0.0.0',
          protocolVersion: 1,
          device: { name: `${process.env.USER ?? 'cli'}-${process.platform}`, platform: process.platform },
          store: { path: storePath, bundleVersion: '1' },
        })

        if (options.verbose) {
          process.stdout.write(`handshake ok • deviceId=${handshake.deviceId} promoted=${handshake.promoted}\n`)
        }

        // Build projection payload from the local bundle.
        const sessions = readSessionsForUpload(bundle).sessions
        const searchDocs = readSearchDocsForUpload(bundle)
        const projection: ProjectionPayload = {
          sourceFiles: [],
          rawRecords: [],
          sessions,
          searchDocs,
        }

        if (options.dryRun) {
          const payload = {
            dryRun: true,
            server,
            tenant: tenantHint,
            store: storePath,
            sessions: sessions.length,
            searchDocs: searchDocs.length,
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(payload)}\n`
              : `[dry-run] would upload ${sessions.length} sessions and ${searchDocs.length} search docs from ${storePath}\n`,
          )
          return
        }

        const plan = await client.syncPlanUpload({
          deviceId: handshake.deviceId,
          storePath,
          objects: [],
        })
        if (options.verbose) {
          process.stdout.write(`plan ok • batchId=${plan.batchId} missingObjects=${plan.missingObjectIds.length}\n`)
        }

        const commit = await client.syncCommitUpload({
          batchId: plan.batchId,
          deviceId: handshake.deviceId,
          storePath,
          objects: [],
          projection,
        })
        if (options.verbose) {
          process.stdout.write(`commit ok • objects=${commit.committedObjects} rows=${commit.committedRows}\n`)
        }

        const verify = await client.syncVerifyPromotion({
          batchId: plan.batchId,
          storePath,
          sampleSessionIds: sessions.slice(0, 5).map((s) => s.id),
        })

        result = {
          batchId: plan.batchId,
          sessionCount: verify.receipt.sessionCount,
          objectCount: verify.receipt.objectCount,
          searchDocCount: verify.receipt.searchDocCount,
        }

        // Update local config with promotion record.
        const nextEntry = recordPromotion(
          { ...entry, device: { id: handshake.deviceId, name: handshake.deviceId } },
          storePath,
          {
            batchId: plan.batchId,
            tenantId: verify.receipt.tenantId,
            promotedAt: verify.receipt.verifiedAt,
            receipt: verify.receipt,
          },
        )
        await saveCliConfig(upsertServer(config, nextEntry, true), configPath)
      } finally {
        closeBundle(bundle)
      }

      let removed: string[] = []
      if (!options.keepLocal) {
        removed = await removeLocalBundle(storePath, Boolean(options.purgeBundle))
        await client
          .syncAckCleanup({ batchId: result.batchId, storePath, removedPaths: removed })
          .catch(() => undefined)
      }

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            server,
            tenant: tenantHint,
            store: storePath,
            ...result,
            removedLocalPaths: removed,
            keptLocal: Boolean(options.keepLocal),
          })}\n`,
        )
      } else {
        const tail = options.keepLocal
          ? `kept local bundle at ${storePath} (marked remote-authoritative)\n`
          : `removed ${removed.length} local paths under ${storePath}\n`
        process.stdout.write(
          `sync ok • batch=${result.batchId} sessions=${result.sessionCount} searchDocs=${result.searchDocCount}\n${tail}`,
        )
      }
    })

  cmd
    .command('status')
    .description('Show local bundle / promotion state for the active server.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--json', 'machine-readable output', false)
    .action(async (options) => {
      const opts = cmd.opts<SyncOptions>()
      const configPath = opts.configPath ?? defaultConfigPath()
      const config = await loadCliConfig(configPath)
      const entry = activeEntry(config)
      if (!entry) {
        process.stdout.write('not logged in\n')
        return
      }
      const storePath = path.resolve(options.store ?? defaultBundlePath())
      const local = await stat(`${storePath}/manifest.json`).then(
        () => true,
        () => false,
      )
      const promoted = isPromoted(entry, storePath)
      const payload = {
        server: entry.url,
        store: storePath,
        localBundleExists: local,
        promoted,
        receipt: entry.promotions?.[storePath]?.receipt ?? null,
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify(payload)}\n`)
      } else {
        process.stdout.write(
          `server: ${payload.server}\n` +
            `store: ${storePath}\n` +
            `local bundle: ${local ? 'present' : 'missing'}\n` +
            `promoted: ${promoted ? 'yes' : 'no'}\n`,
        )
      }
    })

  return cmd
}
