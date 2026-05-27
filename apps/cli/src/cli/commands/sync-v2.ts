// `prosa sync-v2` — Lane 5 CLI command.
//
// Minimal v1 of the command: drives the promoteBundleV2 client against
// the configured server using `fetch`. The on-disk bundle layout
// reader (head.json + inventory segment + pack files) is intentionally
// terse in this slice; richer bundle ingestion, resume/checkpoint
// handling, adaptive concurrency, and progress UI ship in follow-up
// slices.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BundleHeadV2Wire, SegmentRefWire } from '@c3-oss/prosa-wire-v2'
import { Command, Option } from 'commander'
import {
  type PromotionRecord,
  defaultConfigPath,
  loadCliConfig,
  recordPromotion,
  saveCliConfig,
  upsertServer,
} from '../auth/config.js'
import { CliUserError } from '../errors.js'
import { type PromoteHttpClient, type PromoteResult, promoteBundleV2 } from '../v2/sync/promote.js'

type SyncV2Options = {
  server: string
  tokenFile?: string
  tenant: string
  store: string
  device: string
  bundle: string
  json?: boolean
  /**
   * Lane 5 gate L5.6: when true, ignore the server-side status
   * resume optimization (skip the GET .../status call) and
   * re-upload every inventory + pack on this run. Used for a
   * clean-room promotion after local corruption or to force a
   * fresh-write benchmark.
   */
  resume?: boolean
}

const TOKEN_ENV_VAR = 'PROSA_SYNC_TOKEN'

export function syncV2Command(): Command {
  return new Command('sync-v2')
    .description('Promote a v2 bundle to a remote prosa-api server (Lane 5 protocol).')
    .requiredOption('--server <url>', 'prosa-api server base URL (e.g. https://prosa.example.com)')
    .addOption(
      new Option(
        '--token-file <path>',
        `path to a file containing the bearer token (preferred over the ${TOKEN_ENV_VAR} env var). Argv tokens are rejected — CQ-139.`,
      ),
    )
    .requiredOption('--tenant <id>', 'tenant id (organization id)')
    .requiredOption('--store <id>', 'logical store id')
    .requiredOption('--device <id>', 'device id')
    .requiredOption('--bundle <path>', 'path to the v2 bundle directory')
    .addOption(new Option('--json', 'emit machine-readable JSON output instead of human text'))
    .addOption(
      new Option(
        '--no-resume',
        'skip the server-side status resume optimisation and re-upload every inventory + pack on this run',
      ),
    )
    .action(async (opts: SyncV2Options) => {
      const token = await resolveToken(opts.tokenFile)
      const layout = await readBundleLayout(opts.bundle)
      const client = makeFetchClient(opts.server, token)
      const result = await promoteBundleV2(client, {
        tenantId: opts.tenant,
        storeId: opts.store,
        storePath: layout.storePath,
        deviceId: opts.device,
        head: layout.head,
        objectInventory: layout.objectInventory,
        projectionInventory: layout.projectionInventory,
        objectPacks: layout.objectPacks,
        projectionSegments: layout.projectionSegments,
        // commander maps `--no-resume` to `opts.resume = false`.
        skipResume: opts.resume === false,
      })
      await persistPromotion({
        server: opts.server,
        token,
        bundleRoot: path.resolve(opts.bundle),
        tenantId: opts.tenant,
        result,
      })
      reportResult(opts.json === true, result)
    })
}

/**
 * After a successful promote, persist the receipt into
 * `~/.config/prosa/config.json` so `prosa read --authority remote` /
 * `prosa mcp-v2 serve --authority remote` can resolve the bundle's
 * promotion without an extra round-trip. Without this, every sync
 * leaves the operator stuck in `--authority local` even though the
 * receipt is sealed server-side.
 */
async function persistPromotion(input: {
  server: string
  token: string
  bundleRoot: string
  tenantId: string
  result: PromoteResult
}): Promise<void> {
  const configPath = defaultConfigPath()
  const config = await loadCliConfig(configPath)
  const existing = config.servers[input.server]
  // Preserve the existing token / user / active tenant when present;
  // only thread in the freshly used token if the entry is empty.
  const baseEntry = existing ?? { url: input.server, token: input.token }
  const promotedAt =
    typeof input.result.receipt.payload.issuedAt === 'string'
      ? input.result.receipt.payload.issuedAt
      : new Date().toISOString()
  const record: PromotionRecord = {
    batchId: input.result.status === 'sealed' ? input.result.promotionId : input.result.receipt.payload.receiptId,
    tenantId: input.tenantId,
    promotedAt,
    receipt: input.result.receipt,
  }
  const nextEntry = recordPromotion(baseEntry, input.bundleRoot, record)
  const nextConfig = upsertServer(config, nextEntry, existing === undefined)
  await saveCliConfig(nextConfig, configPath)
}

// CQ-139: bearer tokens MUST NOT be passed via argv where they are
// visible in `ps`/`/proc/<pid>/cmdline` and shell history. The CLI
// reads the token from the `PROSA_SYNC_TOKEN` env var or a
// `--token-file <path>` file (single-line file, trailing newline
// stripped). At least one source must be provided.
async function resolveToken(tokenFile?: string): Promise<string> {
  if (tokenFile) {
    try {
      const raw = await readFile(tokenFile, 'utf8')
      const trimmed = raw.trim()
      if (trimmed.length === 0) {
        throw new CliUserError(`token file ${tokenFile} is empty`)
      }
      return trimmed
    } catch (err) {
      if (err instanceof CliUserError) throw err
      throw new CliUserError(`failed to read --token-file ${tokenFile}: ${(err as Error).message}`)
    }
  }
  const envToken = process.env[TOKEN_ENV_VAR]
  if (envToken && envToken.length > 0) return envToken
  throw new CliUserError(`bearer token is required. Set ${TOKEN_ENV_VAR}=<token> or pass --token-file <path> (CQ-139).`)
}

async function readBundleLayout(bundlePath: string): Promise<{
  storePath: string
  head: BundleHeadV2Wire
  objectInventory: { ref: SegmentRefWire; bytes: Uint8Array }
  projectionInventory: { ref: SegmentRefWire; bytes: Uint8Array }
  objectPacks: Array<{ bytes: Uint8Array }>
  projectionSegments: Array<{ ref: SegmentRefWire; bytes: Uint8Array }>
}> {
  const root = path.resolve(bundlePath)
  const headBytes = await readFileOrThrow(path.join(root, 'head.json'))
  const layoutBytes = await readFileOrThrow(path.join(root, 'sync-v2.layout.json'))
  const layout = JSON.parse(new TextDecoder().decode(layoutBytes)) as {
    storePath: string
    objectInventory: { ref: SegmentRefWire; file: string }
    projectionInventory: { ref: SegmentRefWire; file: string }
    objectPacks: Array<{ file: string }>
    // G7 cutover: bundles sealed before the field existed have
    // no `projectionSegments` entry — fall back to an empty list
    // so the CLI keeps working against legacy bundles even though
    // the server then can't materialize their rows.
    projectionSegments?: Array<{ ref: SegmentRefWire; file: string }>
  }
  const head = JSON.parse(new TextDecoder().decode(headBytes)) as BundleHeadV2Wire
  const objectInventory = {
    ref: layout.objectInventory.ref,
    bytes: await readFileOrThrow(path.join(root, layout.objectInventory.file)),
  }
  const projectionInventory = {
    ref: layout.projectionInventory.ref,
    bytes: await readFileOrThrow(path.join(root, layout.projectionInventory.file)),
  }
  const objectPacks = await Promise.all(
    layout.objectPacks.map(async (p) => ({
      bytes: await readFileOrThrow(path.join(root, p.file)),
    })),
  )
  const projectionSegments = await Promise.all(
    (layout.projectionSegments ?? []).map(async (p) => ({
      ref: p.ref,
      bytes: await readFileOrThrow(path.join(root, p.file)),
    })),
  )
  return {
    storePath: layout.storePath,
    head,
    objectInventory,
    projectionInventory,
    objectPacks,
    projectionSegments,
  }
}

async function readFileOrThrow(filePath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(filePath))
  } catch (err) {
    throw new CliUserError(`failed to read ${filePath}: ${(err as Error).message}`)
  }
}

function makeFetchClient(serverUrl: string, token: string): PromoteHttpClient {
  const trimmed = serverUrl.replace(/\/$/, '')
  return async (req) => {
    const url = `${trimmed}${req.url}`
    let body: Uint8Array | string | undefined
    if (req.body == null) {
      body = undefined
    } else if (req.body instanceof Uint8Array) {
      body = req.body
    } else {
      body = JSON.stringify(req.body)
    }
    const response = await fetch(url, {
      method: req.method,
      headers: { ...req.headers, authorization: `Bearer ${token}` },
      body,
    })
    const text = await response.text()
    return {
      statusCode: response.status,
      json: () => (text ? (JSON.parse(text) as unknown) : null),
    }
  }
}

function reportResult(asJson: boolean, result: PromoteResult): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (result.status === 'already_promoted') {
    process.stdout.write(
      `already_promoted: receipt ${result.receipt.payload.receiptId} (bundleRoot ${result.receipt.payload.bundleRoot})\n`,
    )
    return
  }
  process.stdout.write(
    `sealed: promotion ${result.promotionId} receipt ${result.receipt.payload.receiptId} (bundleRoot ${result.receipt.payload.bundleRoot})\n`,
  )
}
