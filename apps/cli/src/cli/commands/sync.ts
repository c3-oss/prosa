import { stat } from 'node:fs/promises'
import path from 'node:path'
import { closeBundle, defaultBundlePath, openBundle } from '@c3-oss/prosa-core'
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
import { readBundleForUpload } from '../sync/bundle.js'
import { readUploadCounts, uploadLimitViolations } from '../sync/limits.js'
import { promoteUpload, removeLocalBundle } from '../sync/promotion.js'

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

type SyncResult = {
  batchId: string
  sessionCount: number
  objectCount: number
  searchDocCount: number
}

async function bundleManifestExists(storePath: string): Promise<boolean> {
  return stat(`${storePath}/manifest.json`).then(
    () => true,
    () => false,
  )
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
        'Only use after the remote receipt verifies the declared bundle contents.',
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
      const exists = await bundleManifestExists(storePath)
      if (!exists) throw new CliUserError(`no prosa bundle at ${storePath}`)

      const bundle = await openBundle(storePath)
      let result: SyncResult
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

        const counts = readUploadCounts(bundle, handshake.limits)
        const limitViolations = uploadLimitViolations(counts, handshake.limits)

        if (options.dryRun) {
          const payload = {
            dryRun: true,
            server,
            tenant: tenantHint,
            store: storePath,
            sessions: counts.sessions,
            searchDocs: counts.searchDocs,
            sourceFiles: counts.sourceFiles,
            rawRecords: counts.rawRecords,
            casObjects: counts.casObjects,
            limitViolations,
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(payload)}\n`
              : `[dry-run] would upload ${counts.sessions} sessions, ${counts.searchDocs} search docs, ${counts.sourceFiles} source files, ${counts.rawRecords} raw records, ${counts.casObjects} CAS objects from ${storePath}\n`,
          )
          return
        }

        if (limitViolations.length > 0) {
          throw new CliUserError(
            `bundle is too large for a single sync batch: ${limitViolations.join('; ')}. Rebuild with fewer sessions or wait for chunked sync support.`,
          )
        }

        const upload = await readBundleForUpload(bundle, storePath)
        const promotion = await promoteUpload({
          client,
          deviceId: handshake.deviceId,
          storePath,
          upload,
          verbose: options.verbose,
        })

        result = {
          batchId: promotion.batchId,
          sessionCount: promotion.sessionCount,
          objectCount: promotion.objectCount,
          searchDocCount: promotion.searchDocCount,
        }

        const nextEntry = recordPromotion(
          { ...entry, device: { id: handshake.deviceId, name: handshake.deviceId } },
          storePath,
          {
            batchId: promotion.batchId,
            tenantId: promotion.receipt.tenantId,
            promotedAt: promotion.receipt.verifiedAt,
            receipt: promotion.receipt,
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
      const local = await bundleManifestExists(storePath)
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
