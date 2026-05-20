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
import { CliUserError } from '../errors.js'
import { type PromoteHttpClient, type PromoteResult, promoteBundleV2 } from '../v2/sync/promote.js'

type SyncV2Options = {
  server: string
  token: string
  tenant: string
  store: string
  device: string
  bundle: string
  json?: boolean
}

export function syncV2Command(): Command {
  return new Command('sync-v2')
    .description('Promote a v2 bundle to a remote prosa-api server (Lane 5 protocol).')
    .requiredOption('--server <url>', 'prosa-api server base URL (e.g. https://prosa.example.com)')
    .requiredOption('--token <token>', 'bearer token issued by the server')
    .requiredOption('--tenant <id>', 'tenant id (organization id)')
    .requiredOption('--store <id>', 'logical store id')
    .requiredOption('--device <id>', 'device id')
    .requiredOption('--bundle <path>', 'path to the v2 bundle directory')
    .addOption(new Option('--json', 'emit machine-readable JSON output instead of human text'))
    .action(async (opts: SyncV2Options) => {
      const layout = await readBundleLayout(opts.bundle)
      const client = makeFetchClient(opts.server, opts.token)
      const result = await promoteBundleV2(client, {
        tenantId: opts.tenant,
        storeId: opts.store,
        storePath: layout.storePath,
        deviceId: opts.device,
        head: layout.head,
        objectInventory: layout.objectInventory,
        projectionInventory: layout.projectionInventory,
        objectPacks: layout.objectPacks,
      })
      reportResult(opts.json === true, result)
    })
}

async function readBundleLayout(bundlePath: string): Promise<{
  storePath: string
  head: BundleHeadV2Wire
  objectInventory: { ref: SegmentRefWire; bytes: Uint8Array }
  projectionInventory: { ref: SegmentRefWire; bytes: Uint8Array }
  objectPacks: Array<{ bytes: Uint8Array }>
}> {
  const root = path.resolve(bundlePath)
  const headBytes = await readFileOrThrow(path.join(root, 'head.json'))
  const layoutBytes = await readFileOrThrow(path.join(root, 'sync-v2.layout.json'))
  const layout = JSON.parse(new TextDecoder().decode(layoutBytes)) as {
    storePath: string
    objectInventory: { ref: SegmentRefWire; file: string }
    projectionInventory: { ref: SegmentRefWire; file: string }
    objectPacks: Array<{ file: string }>
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
  return { storePath: layout.storePath, head, objectInventory, projectionInventory, objectPacks }
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
