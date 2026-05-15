import { Command } from 'commander'
import { ProsaApiClient } from '../auth/client.js'
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

type AuthOptions = { server?: string; configPath?: string }

function resolveServer(opts: AuthOptions): string {
  return opts.server ?? process.env.PROSA_SERVER_URL ?? 'http://127.0.0.1:3000'
}

function activeOrThrow(opts: AuthOptions): Promise<ProsaServerEntry> {
  return loadCliConfig(opts.configPath ?? defaultConfigPath()).then((config) => {
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
      const config = await loadCliConfig(cmd.opts<AuthOptions>().configPath ?? defaultConfigPath())
      const entry: ProsaServerEntry = {
        url: server,
        user: { id: result.user.id, email: result.user.email, name: result.user.name },
        token: result.token,
        activeTenant: result.tenant,
      }
      await saveCliConfig(upsertServer(config, entry, true), cmd.opts<AuthOptions>().configPath ?? defaultConfigPath())
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
      const result = await client.signInEmail({ email: options.email, password: options.password })
      client.token = result.token
      const tenants = await client.listTenants()
      const config = await loadCliConfig(cmd.opts<AuthOptions>().configPath ?? defaultConfigPath())
      const entry: ProsaServerEntry = {
        url: server,
        user: result.user,
        token: result.token,
      }
      const first = tenants[0]
      if (first) entry.activeTenant = first
      await saveCliConfig(upsertServer(config, entry, true), cmd.opts<AuthOptions>().configPath ?? defaultConfigPath())
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, server, user: result.user, tenants })}\n`)
      } else {
        process.stdout.write(
          `logged in as ${result.user.email}; ${tenants.length} tenant(s) available${first ? ` (active: ${first.name})` : ''}\n`,
        )
      }
    })

  cmd
    .command('logout')
    .description('Clear local credentials for the active server.')
    .option('--all', 'remove the full CLI config', false)
    .action(async (options) => {
      const configPath = cmd.opts<AuthOptions>().configPath ?? defaultConfigPath()
      if (options.all) {
        await clearCliConfig(configPath)
        process.stdout.write('cleared all local prosa CLI credentials\n')
        return
      }
      const config = await loadCliConfig(configPath)
      const entry = activeEntry(config)
      if (entry?.token) {
        const client = new ProsaApiClient({ baseUrl: entry.url, token: entry.token })
        await client.signOut().catch(() => undefined)
      }
      if (config.activeServer) {
        const { [config.activeServer]: _removed, ...rest } = config.servers
        config.servers = rest
        config.activeServer = undefined
      }
      await saveCliConfig(config, configPath)
      process.stdout.write('logged out\n')
    })

  cmd
    .command('status')
    .description('Show current login, tenant, and promotion state.')
    .option('--json', 'machine-readable output', false)
    .action(async (options) => {
      const configPath = cmd.opts<AuthOptions>().configPath ?? defaultConfigPath()
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
        promotedStores: Object.keys(entry.promotions ?? {}),
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary)}\n`)
      } else {
        process.stdout.write(
          `server: ${summary.server}\n` +
            `user: ${entry.user?.email ?? '(unknown)'}\n` +
            `tenant: ${entry.activeTenant?.name ?? '(none)'}\n` +
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
      const configPath = cmd.opts<AuthOptions>().configPath ?? defaultConfigPath()
      const entry = await activeOrThrow({ configPath })
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
      const configPath = cmd.opts<AuthOptions>().configPath ?? defaultConfigPath()
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
