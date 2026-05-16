import { Command } from 'commander'
import { ProsaApiClient, ProsaApiError } from '../auth/client.js'
import {
  type ProsaServerEntry,
  activeEntry,
  clearCliConfig,
  defaultConfigPath,
  loadCliConfig,
  saveCliConfig,
  upsertServer,
} from '../auth/config.js'
import { CliUserError } from '../errors.js'
import { emitStatus } from '../ink/messages.js'
import { withSpinner } from '../ink/spinner.js'

type AuthOptions = { server?: string; config?: string }

function resolveServer(opts: AuthOptions): string {
  return opts.server ?? process.env.PROSA_SERVER_URL ?? 'http://127.0.0.1:3000'
}

function resolveConfigPath(opts: AuthOptions): string {
  return opts.config ?? defaultConfigPath()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveSeconds(value: unknown): number | null {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

function retryAfterSecondsFromError(err: unknown): number | null {
  if (err instanceof ProsaApiError) {
    return err.retryAfterSeconds ?? (err.code === 'TOO_MANY_REQUESTS' ? 5 : null)
  }
  const message = err instanceof Error ? err.message : String(err)
  const match = /\bRetry after\s+(\d+)s\b/i.exec(message)
  if (match) return positiveSeconds(match[1])
  return /rate limit|too many requests/i.test(message) ? 5 : null
}

async function fetchTokenExpiresAt(client: ProsaApiClient): Promise<string | undefined> {
  try {
    const me = await client.me()
    const expiresAt = me.session?.expiresAt ?? me.session?.expires_at
    return typeof expiresAt === 'string' ? expiresAt : undefined
  } catch {
    return undefined
  }
}

function activeOrThrow(opts: AuthOptions): Promise<ProsaServerEntry> {
  return loadCliConfig(resolveConfigPath(opts)).then((config) => {
    const entry = activeEntry(config)
    if (!entry || !entry.token) {
      throw new CliUserError('not logged in. Run `prosa auth login` first.')
    }
    return entry
  })
}

export function authCommand(): Command {
  const cmd = new Command('auth').description('Authenticate with a remote prosa server.')
  cmd.option('--config <path>', 'override CLI config path')

  cmd
    .command('signup')
    .description('Create a user, tenant, and active session on the remote server.')
    .option('--server <url>', 'API server URL')
    .requiredOption('--email <email>', 'user email')
    .requiredOption('--password <password>', 'password (>= 8 chars)')
    .requiredOption('--name <name>', 'display name')
    .requiredOption('--tenant <tenantName>', 'tenant display name')
    .option('--tenant-slug <slug>', 'optional tenant slug')
    .option('--json', 'machine-readable JSON output', false)
    .action(async (options) => {
      const server = resolveServer(options)
      const client = new ProsaApiClient({ baseUrl: server })
      const result = await client.signupWithTenant({
        email: options.email,
        password: options.password,
        name: options.name,
        tenantName: options.tenant,
        ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
      })
      if (!result.token) {
        throw new Error(
          'signup did not return a CLI bearer token. Browser flows use cookies; for the CLI ensure the API is reachable from the CLI origin and `PROSA_WEB_ORIGIN` does not include it.',
        )
      }
      client.token = result.token
      const tokenExpiresAt = await fetchTokenExpiresAt(client)
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      const config = await loadCliConfig(configPath)
      const entry: ProsaServerEntry = {
        url: server,
        user: { id: result.user.id, email: result.user.email, name: result.user.name },
        token: result.token,
        activeTenant: result.tenant,
      }
      if (tokenExpiresAt) entry.tokenExpiresAt = tokenExpiresAt
      await saveCliConfig(upsertServer(config, entry, true), configPath)
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, server, tenant: result.tenant })}\n`)
      } else {
        process.stdout.write(
          `signed up as ${result.user.email}; tenant '${result.tenant.name}' is active on ${server}\n`,
        )
      }
    })

  cmd
    .command('login')
    .description('Log in with email and password.')
    .option('--server <url>', 'API server URL')
    .requiredOption('--email <email>', 'user email')
    .requiredOption('--password <password>', 'password')
    .option('--json', 'machine-readable JSON output', false)
    .action(async (options) => {
      const server = resolveServer(options)
      const client = new ProsaApiClient({ baseUrl: server })
      const result = await withSpinner(
        `Signing in to ${server}…`,
        () => client.signInEmail({ email: options.email, password: options.password }),
        { quiet: options.json },
      )
      client.token = result.token
      const tokenExpiresAt = await fetchTokenExpiresAt(client)
      const tenants = await withSpinner('Fetching tenants…', () => client.listTenants(), { quiet: options.json })
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      const config = await loadCliConfig(configPath)
      const entry: ProsaServerEntry = {
        url: server,
        user: result.user,
        token: result.token,
      }
      if (tokenExpiresAt) entry.tokenExpiresAt = tokenExpiresAt
      const first = tenants[0]
      if (first) entry.activeTenant = first
      await saveCliConfig(upsertServer(config, entry, true), configPath)
      const plain = options.json
        ? `${JSON.stringify({ ok: true, server, user: result.user, tenants })}\n`
        : `logged in as ${result.user.email}; ${tenants.length} tenant(s) available${first ? ` (active: ${first.name})` : ''}\n`
      await emitStatus({
        json: options.json,
        variant: 'success',
        message: `Logged in as ${result.user.email}${first ? ` (tenant: ${first.name})` : ''}`,
        plain,
      })
    })

  cmd
    .command('device-login')
    .description('Log in via OAuth Device Authorization (no password prompt).')
    .option('--server <url>', 'API server URL')
    .option('--client-id <id>', 'OAuth client id', 'prosa-cli')
    .option('--json', 'machine-readable JSON output', false)
    .option('--poll-max-seconds <n>', 'polling timeout cap, in seconds', '900')
    .action(async (options) => {
      const server = resolveServer(options)
      const client = new ProsaApiClient({ baseUrl: server })
      const issued = await client.deviceCode({ clientId: options.clientId })
      const verificationUrl = issued.verificationUriComplete ?? issued.verificationUri
      const codeHint = issued.verificationUriComplete
        ? `If prompted, enter the code: ${issued.userCode}\n`
        : `Enter the code: ${issued.userCode}\n`
      const pollMaxSeconds = Math.max(60, positiveSeconds(options.pollMaxSeconds) ?? 900)
      if (!options.json) {
        process.stdout.write(
          `Visit ${verificationUrl}\n${codeHint}` +
            `Waiting for approval (polling every ${issued.interval}s, max ${pollMaxSeconds}s)...\n`,
        )
      } else {
        process.stdout.write(
          `${JSON.stringify({
            kind: 'device-code',
            userCode: issued.userCode,
            verificationUri: issued.verificationUri,
            verificationUriComplete: issued.verificationUriComplete,
            expiresIn: issued.expiresIn,
            interval: issued.interval,
          })}\n`,
        )
      }
      let intervalMs = Math.max(1, issued.interval) * 1000
      const deadline = Date.now() + pollMaxSeconds * 1000
      let user: { id: string; email: string; name: string } | null = null
      let token: string | null = null
      while (Date.now() < deadline) {
        await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
        if (Date.now() >= deadline) break
        const tokenResp = await client
          .deviceToken({
            deviceCode: issued.deviceCode,
            clientId: options.clientId,
          })
          .catch((err: unknown) => {
            const retryAfterSeconds = retryAfterSecondsFromError(err)
            if (retryAfterSeconds == null) throw err
            intervalMs = Math.max(intervalMs + 5_000, retryAfterSeconds * 1000)
            return { pending: true as const, code: 'rate_limited' }
          })
        if (!tokenResp.pending) {
          token = tokenResp.token
          user = tokenResp.user
          break
        }
        if (tokenResp.code === 'slow_down') {
          intervalMs += 5_000
        }
      }
      if (!token) {
        throw new CliUserError('device login timed out before approval')
      }
      const finalClient = new ProsaApiClient({ baseUrl: server, token })
      const tokenExpiresAt = await fetchTokenExpiresAt(finalClient)
      const tenants = await finalClient.listTenants()
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      const config = await loadCliConfig(configPath)
      const entry: ProsaServerEntry = { url: server, token }
      if (user) entry.user = user
      if (tokenExpiresAt) entry.tokenExpiresAt = tokenExpiresAt
      const first = tenants[0]
      if (first) entry.activeTenant = first
      await saveCliConfig(upsertServer(config, entry, true), configPath)
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, server, user, tenants })}\n`)
      } else {
        process.stdout.write(
          `device login complete; ${tenants.length} tenant(s) available${first ? ` (active: ${first.name})` : ''}\n`,
        )
      }
    })

  cmd
    .command('logout')
    .description('Clear local credentials for the active server.')
    .option('--all', 'remove the full CLI config', false)
    .action(async (options) => {
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      if (options.all) {
        await clearCliConfig(configPath)
        await emitStatus({
          variant: 'success',
          message: 'Cleared all local prosa CLI credentials',
          plain: 'cleared all local prosa CLI credentials\n',
        })
        return
      }
      const config = await loadCliConfig(configPath)
      const entry = activeEntry(config)
      let revokeError: unknown = null
      if (entry?.token) {
        const client = new ProsaApiClient({ baseUrl: entry.url, token: entry.token })
        await withSpinner('Revoking remote session…', async () => {
          await client.signOut().catch((err: unknown) => {
            revokeError = err
          })
        })
      }
      if (config.activeServer) {
        const { [config.activeServer]: _removed, ...rest } = config.servers
        config.servers = rest
        config.activeServer = undefined
      }
      await saveCliConfig(config, configPath)
      if (revokeError) {
        const message = revokeError instanceof Error ? revokeError.message : String(revokeError)
        await emitStatus({
          variant: 'warning',
          message: `Logged out locally; remote session revocation failed: ${message}`,
          plain: `logged out locally; remote session revocation failed: ${message}\n`,
        })
      } else {
        await emitStatus({
          variant: 'success',
          message: 'Logged out',
          plain: 'logged out\n',
        })
      }
    })

  cmd
    .command('status')
    .description('Show current login, tenant, and promotion state.')
    .option('--json', 'machine-readable output', false)
    .action(async (options) => {
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      const config = await loadCliConfig(configPath)
      const entry = activeEntry(config)
      if (!entry) {
        const payload = { loggedIn: false }
        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload)}\n`)
        } else {
          process.stdout.write('not logged in\n')
        }
        return
      }
      const summary = {
        loggedIn: Boolean(entry.token),
        server: entry.url,
        user: entry.user ?? null,
        activeTenant: entry.activeTenant ?? null,
        device: entry.device ?? null,
        tokenExpiresAt: entry.tokenExpiresAt ?? null,
        promotedStores: Object.keys(entry.promotions ?? {}),
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary)}\n`)
      } else {
        process.stdout.write(
          `server: ${summary.server}\n` +
            `user: ${entry.user?.email ?? '(unknown)'}\n` +
            `tenant: ${entry.activeTenant?.name ?? '(none)'}\n` +
            `token expires: ${entry.tokenExpiresAt ?? '(unknown)'}\n` +
            `device: ${entry.device?.name ?? '(none)'}\n` +
            `promoted: ${summary.promotedStores.length}\n`,
        )
      }
    })

  cmd
    .command('tenants')
    .description('List tenants available to the current user.')
    .option('--json', 'machine-readable output', false)
    .action(async (options) => {
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      const entry = await activeOrThrow({ config: configPath })
      const client = new ProsaApiClient({ baseUrl: entry.url, token: entry.token })
      const tenants = await client.listTenants()
      if (options.json) {
        process.stdout.write(`${JSON.stringify(tenants)}\n`)
      } else {
        for (const t of tenants) {
          process.stdout.write(`${t.id}\t${t.name}\t${t.slug ?? ''}\n`)
        }
      }
    })

  cmd
    .command('use')
    .argument('<tenant>', 'tenant id or slug')
    .description('Set the active tenant for future commands.')
    .action(async (tenantSpec: string) => {
      const configPath = resolveConfigPath(cmd.opts<AuthOptions>())
      const config = await loadCliConfig(configPath)
      const entry = activeEntry(config)
      if (!entry) throw new CliUserError('not logged in')
      const client = new ProsaApiClient({ baseUrl: entry.url, token: entry.token })
      const tenants = await client.listTenants()
      const match = tenants.find((t) => t.id === tenantSpec || t.slug === tenantSpec)
      if (!match) throw new CliUserError(`unknown tenant: ${tenantSpec}`)
      await client.setActiveTenant(match.id)
      const next = upsertServer(config, { ...entry, activeTenant: match }, true)
      await saveCliConfig(next, configPath)
      process.stdout.write(`active tenant: ${match.name} (${match.id})\n`)
    })

  return cmd
}
