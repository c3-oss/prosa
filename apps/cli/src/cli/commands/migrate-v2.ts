// `prosa migrate-v2` — Lane 9 CLI surface.
//
// Two subcommands:
//   - `bundle` — local migration. Reads v1 bundle preserved bytes
//     and re-projects them through the v2 importer pipeline. On
//     success the v1 bundle is archived next to its original path
//     and the new v2 bundle takes the original path.
//   - `tenant` — remote re-projection. Calls
//     `POST /v2/migrate/tenant` against the configured API. Admin
//     credentials are required server-side (Lane 9 server scope).
//
// `--verbose` adds per-phase timing lines (`discovery`, `reproject`,
// `validate`, `rename`) to stderr. `--json` switches stdout to a
// single result blob suitable for automation.
//
// This command never bypasses validation. Any count-validation
// failure aborts before the atomic rename so the v1 bundle stays
// intact.

import { Command } from 'commander'

import { migrateBundle } from '../v2/migrate/bundle.js'

type MigrateBundleCliOptions = {
  old: string
  new: string
  verbose: boolean
  json: boolean
  dryRun: boolean
  archivePath?: string
  codexRoot?: string
  claudeRoot?: string
  cursorRoot?: string
  geminiRoot?: string
  hermesRoot?: string
}

export function migrateV2Command(): Command {
  const cmd = new Command('migrate-v2').description(
    'Migrate a v1 prosa bundle (or tenant) to the v2 layout via the v2 importer pipeline.',
  )

  cmd.addCommand(migrateV2BundleCommand())
  cmd.addCommand(migrateV2TenantCommand())
  return cmd
}

function migrateV2BundleCommand(): Command {
  return new Command('bundle')
    .description('Migrate a local v1 bundle to v2 by re-projecting preserved raw bytes.')
    .requiredOption('--old <path>', 'path to the v1 bundle (typically ~/.prosa)')
    .requiredOption('--new <path>', 'temp path for the new v2 bundle (typically ~/.prosa-v2-tmp)')
    .option('--archive-path <path>', 'override the v1 archive path (defaults to <old>-v0-archive-<timestamp>)')
    .option('--verbose', 'print per-phase timing to stderr', false)
    .option('--json', 'emit a single JSON result blob on stdout', false)
    .option('--dry-run', 'run migration + validation but skip the atomic rename', false)
    .option('--codex-root <path>', 'override the Codex fallback root for missing raw bytes')
    .option('--claude-root <path>', 'override the Claude Code fallback root for missing raw bytes')
    .option('--cursor-root <path>', 'override the Cursor fallback root for missing raw bytes')
    .option('--gemini-root <path>', 'override the Gemini fallback root for missing raw bytes')
    .option('--hermes-root <path>', 'override the Hermes fallback root for missing raw bytes')
    .action(async (options: MigrateBundleCliOptions) => {
      try {
        const result = await migrateBundle({
          oldPath: options.old,
          newPath: options.new,
          archivePath: options.archivePath,
          dryRun: options.dryRun,
          providerRoots: {
            codex: options.codexRoot,
            claude: options.claudeRoot,
            cursor: options.cursorRoot,
            gemini: options.geminiRoot,
            hermes: options.hermesRoot,
          },
        })
        if (options.verbose && !options.json) {
          for (const phase of result.phases) {
            process.stderr.write(`migrate-v2 bundle: ${phase.phase} ${phase.durationMs}ms\n`)
          }
        }
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        } else {
          process.stdout.write(
            [
              `migrated v1 bundle ${options.old} → ${result.v2Path}`,
              `archive: ${result.archivedAt ?? '(dry-run)'}`,
              `validation ok=${result.validation.ok}`,
              `sourceFiles v1=${result.validation.v1Counts.sourceFiles} v2=${result.validation.v2Counts.sourceFiles}`,
              `rawRecords v1=${result.validation.v1Counts.rawRecords} v2=${result.validation.v2Counts.rawRecords}`,
              `sessions   v1=${result.validation.v1Counts.sessions}    v2=${result.validation.v2Counts.sessions}`,
              `objects    v1=${result.validation.v1Counts.objects}     v2=${result.validation.v2Counts.objects}`,
              `searchDocs v1=${result.validation.v1Counts.searchDocs}  v2=${result.validation.v2Counts.searchDocs}`,
              `gaps: ${result.gaps.length}`,
              `duration: ${result.durationMs}ms`,
              '',
            ].join('\n'),
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (options.json) {
          process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
        } else {
          process.stderr.write(`migrate-v2 bundle failed: ${message}\n`)
        }
        process.exit(1)
      }
    })
}

type MigrateTenantCliOptions = {
  apiUrl: string
  token: string
  tenantId: string
  storeId?: string
  json: boolean
  verbose: boolean
}

function migrateV2TenantCommand(): Command {
  return new Command('tenant')
    .description('Trigger a remote v1 → v2 re-projection on the configured prosa API server (admin only).')
    .requiredOption('--api-url <url>', 'prosa API base URL (e.g. https://api.example.com)')
    .requiredOption('--token <token>', 'Bearer token for the admin user')
    .requiredOption('--tenant-id <id>', 'tenant id to re-project')
    .option('--store-id <id>', 'optional store id scope; omitted to migrate every store in the tenant')
    .option('--json', 'emit the server JSON response verbatim on stdout', false)
    .option('--verbose', 'print HTTP status to stderr', false)
    .action(async (options: MigrateTenantCliOptions) => {
      const url = `${options.apiUrl.replace(/\/$/, '')}/v2/migrate/tenant`
      const payload: Record<string, unknown> = { tenantId: options.tenantId }
      if (options.storeId) payload.storeId = options.storeId
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.token}`,
          },
          body: JSON.stringify(payload),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`migrate-v2 tenant failed: ${message}\n`)
        process.exit(1)
        return
      }
      const text = await response.text()
      if (options.verbose) {
        process.stderr.write(`migrate-v2 tenant: HTTP ${response.status}\n`)
      }
      if (!response.ok) {
        process.stderr.write(text + (text.endsWith('\n') ? '' : '\n'))
        process.exit(1)
        return
      }
      if (options.json) {
        process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'))
      } else {
        try {
          const body = JSON.parse(text) as {
            migratedAt?: string
            receiptId?: string
            gaps?: unknown[]
          }
          process.stdout.write(
            [
              `tenant migrated at ${body.migratedAt ?? '(unknown)'}`,
              `receiptId: ${body.receiptId ?? '(none)'}`,
              `gaps: ${Array.isArray(body.gaps) ? body.gaps.length : 0}`,
              '',
            ].join('\n'),
          )
        } catch {
          process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'))
        }
      }
    })
}
