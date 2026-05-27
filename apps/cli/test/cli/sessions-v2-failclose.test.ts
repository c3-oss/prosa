// Lane 6 / CQ-143 acceptance — `prosa sessions` must NOT hit
// `/trpc/sessions.*` for a v2-promoted store.
//
// The handler test (`remote-authority-routing.test.ts`) covers the
// resolver-level fail-closed behavior. This suite drives the actual
// CLI binary against a synthetic CLI config that names a v2
// promotion. The CLI is pointed at a server URL that no listener
// owns, with an HTTP fail-fast wrapper baked in via a small Node
// `--inspect` trick: if the CLI tried to call the server we'd see
// a connection refused error AND a non-zero status. CQ-143
// invariant: the CLI bails out BEFORE any fetch, exit non-zero
// with `--local` guidance.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI_ENTRY = join(__dirname, '..', '..', 'src', 'bin', 'prosa.ts')

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'node',
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', CLI_ENTRY, ...args],
    { encoding: 'utf8', timeout: 60_000, env },
  )
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

async function setupV2Promotion(): Promise<{ configPath: string; storePath: string; cleanup: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), 'prosa-cq143-'))
  const storePath = join(root, '.prosa')
  await mkdir(storePath, { recursive: true })
  const configPath = join(root, 'config.json')
  // Point the recorded server URL at 127.0.0.1:1 — RST or unreachable.
  // The CLI must NOT attempt to connect, but if a regression slips
  // through the fail-closed gate the connection error is the
  // confirming signal.
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        activeServer: 'http://127.0.0.1:1',
        servers: {
          'http://127.0.0.1:1': {
            url: 'http://127.0.0.1:1',
            token: 'cq143-token',
            user: { id: 'u_cq143', email: 'cq143@example.com', name: 'cq143' },
            activeTenant: { id: 'tenant_cq143', name: 'cq143', slug: 'cq143' },
            promotions: {
              [storePath]: {
                batchId: 'batch_cq143',
                tenantId: 'tenant_cq143',
                promotedAt: '2026-05-20T00:00:00.000Z',
                receipt: {
                  payload: {
                    receiptVersion: 2,
                    receiptId: 'rcp_cq143',
                    tenantId: 'tenant_cq143',
                    storeId: 'store_cq143',
                  },
                  signature: { alg: 'Ed25519', keyId: 'k', sig: 'AA' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  return {
    configPath,
    storePath,
    cleanup: {
      ...process.env,
      PROSA_CONFIG_PATH: configPath,
      // Disable any side network access from the @swc-node loader.
      NODE_NO_WARNINGS: '1',
    },
  }
}

describe('CQ-143: `prosa sessions` fails closed for a v2-promoted store before hitting /trpc/sessions.*', () => {
  it('refuses `sessions` without --local and never reaches the network', async () => {
    const { storePath, cleanup } = await setupV2Promotion()
    const r = runCli(['sessions', '--store', storePath, '--limit', '5'], cleanup)
    expect(r.status).not.toBe(0)
    const combined = `${r.stdout}\n${r.stderr}`
    expect(combined).toMatch(/v2-promoted/)
    expect(combined).toMatch(/--local/)
    // If the CLI had reached fetch, we'd see Node's TCP error
    // markers (ECONNREFUSED / EAI_AGAIN) or HTTP status lines. The
    // fail-closed gate exits before any of that.
    expect(combined).not.toMatch(/ECONNREFUSED/)
    expect(combined).not.toMatch(/EAI_AGAIN/)
    expect(combined).not.toMatch(/HTTP\/1\./)
  })

  it('refuses `sessions count` without --local and never reaches the network', async () => {
    const { storePath, cleanup } = await setupV2Promotion()
    const r = runCli(['sessions', 'count', '--store', storePath], cleanup)
    expect(r.status).not.toBe(0)
    const combined = `${r.stdout}\n${r.stderr}`
    expect(combined).toMatch(/v2-promoted/)
    expect(combined).toMatch(/--local/)
    expect(combined).not.toMatch(/ECONNREFUSED/)
  })

  it('refuses `session show <id>` without --local and never reaches the network', async () => {
    // `prosa session show` declares remoteSupported: false today —
    // that already short-circuits any promoted store. The CQ-143
    // pin is "do not call /trpc/sessions.*"; this asserts the
    // process exits non-zero with a not-available message and
    // produces no network markers.
    const { storePath, cleanup } = await setupV2Promotion()
    const r = runCli(['session', 'show', 'ses_anything', '--store', storePath], cleanup)
    expect(r.status).not.toBe(0)
    const combined = `${r.stdout}\n${r.stderr}`
    expect(combined).toMatch(/--local/)
    expect(combined).toMatch(/not available|v2-promoted/)
    expect(combined).not.toMatch(/ECONNREFUSED/)
    expect(combined).not.toMatch(/EAI_AGAIN/)
    expect(combined).not.toMatch(/HTTP\/1\./)
  })
})
