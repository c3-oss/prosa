import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'

type BenchOptions = {
  sourceStore: string
  server: string
  workDir?: string
  output?: string
  objectConcurrency: string
  batchConcurrency: string
  startStack: boolean
  stopStack: boolean
  keepWorkDir: boolean
  email: string
  password: string
  tenantSlug: string
}

type CommandResult = {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  wallMs: number
}

type SyncRunResult = CommandResult & {
  parsedJson: unknown
}

type BenchReport = {
  createdAt: string
  sourceStore: string
  copiedStore: string
  configPath: string
  server: string
  objectConcurrency: number
  batchConcurrency: number
  dryRun: SyncRunResult
  coldSync: SyncRunResult
  warmSync: SyncRunResult
}

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = {
    sourceStore: path.join(homedir(), '.prosa'),
    server: 'http://127.0.0.1:3000',
    objectConcurrency: '32',
    batchConcurrency: '4',
    startStack: false,
    stopStack: false,
    keepWorkDir: false,
    email: `bench-${Date.now()}@example.com`,
    password: 'correct-horse-battery',
    tenantSlug: `bench-${Date.now()}`,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value) throw new Error(`missing value for ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--source-store':
        opts.sourceStore = next()
        break
      case '--server':
        opts.server = next()
        break
      case '--work-dir':
        opts.workDir = next()
        break
      case '--output':
        opts.output = next()
        break
      case '--object-concurrency':
        opts.objectConcurrency = next()
        break
      case '--batch-concurrency':
        opts.batchConcurrency = next()
        break
      case '--email':
        opts.email = next()
        break
      case '--password':
        opts.password = next()
        break
      case '--tenant-slug':
        opts.tenantSlug = next()
        break
      case '--start-stack':
        opts.startStack = true
        break
      case '--stop-stack':
        opts.stopStack = true
        break
      case '--keep-work-dir':
        opts.keepWorkDir = true
        break
      case '--help':
        printHelp()
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node --import @swc-node/register/esm-register bench/bench-sync-docker.ts [options]

Options:
  --source-store <path>       Source bundle to copy (default: ~/.prosa)
  --server <url>              API server URL (default: http://127.0.0.1:3000)
  --work-dir <path>           Existing/created temp work root
  --output <path>             Write JSON report to this file
  --object-concurrency <n>    Sync object concurrency (default: 32)
  --batch-concurrency <n>     Sync batch concurrency (default: 4)
  --start-stack               Run 'docker compose up -d --wait' first
  --stop-stack                Run 'docker compose down -v' after the benchmark
  --keep-work-dir             Do not delete the copied store/config after run
`)
}

function commandLine(command: string, args: string[]): string[] {
  return [command, ...args]
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const started = performance.now()
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
  const result = {
    command: commandLine(command, args),
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    wallMs: Math.round(performance.now() - started),
  }
  if (exitCode !== 0) {
    throw new Error(
      `command failed (${exitCode}): ${result.command.join(' ')}\n${result.stderr}\n${result.stdout}`,
    )
  }
  return result
}

function parseJsonOutput(result: CommandResult): SyncRunResult {
  return {
    ...result,
    parsedJson: JSON.parse(result.stdout.trim()),
  }
}

function prosaArgs(args: string[]): string[] {
  return ['--filter', '@c3-oss/prosa', 'dev', '--', ...args]
}

async function runSync(args: string[], env: NodeJS.ProcessEnv): Promise<SyncRunResult> {
  return parseJsonOutput(await run('pnpm', prosaArgs(args), env))
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const workRoot = opts.workDir
    ? path.resolve(opts.workDir)
    : await mkdtemp(path.join(tmpdir(), 'prosa-sync-bench-'))
  const copiedStore = path.join(workRoot, '.prosa')
  const configPath = path.join(workRoot, 'config.json')
  const env = { ...process.env, PROSA_CONFIG_PATH: configPath }

  await mkdir(workRoot, { recursive: true })
  if (opts.startStack) await run('docker', ['compose', 'up', '-d', '--wait'], env)

  try {
    await rm(copiedStore, { recursive: true, force: true })
    await cp(path.resolve(opts.sourceStore), copiedStore, { recursive: true, verbatimSymlinks: true })
    await run(
      'pnpm',
      prosaArgs([
        'auth',
        'signup',
        '--server',
        opts.server,
        '--email',
        opts.email,
        '--password',
        opts.password,
        '--name',
        'Sync Bench',
        '--tenant',
        'Sync Bench',
        '--tenant-slug',
        opts.tenantSlug,
        '--json',
      ]),
      env,
    )

    const commonSyncArgs = [
      'sync',
      '--server',
      opts.server,
      '--store',
      copiedStore,
      '--keep-local',
      '--json',
      '--object-concurrency',
      opts.objectConcurrency,
      '--batch-concurrency',
      opts.batchConcurrency,
    ]
    const dryRun = await runSync([...commonSyncArgs, '--dry-run'], env)
    const coldSync = await runSync(commonSyncArgs, env)
    const warmSync = await runSync(commonSyncArgs, env)
    const report: BenchReport = {
      createdAt: new Date().toISOString(),
      sourceStore: path.resolve(opts.sourceStore),
      copiedStore,
      configPath,
      server: opts.server,
      objectConcurrency: Number(opts.objectConcurrency),
      batchConcurrency: Number(opts.batchConcurrency),
      dryRun,
      coldSync,
      warmSync,
    }
    const json = `${JSON.stringify(report, null, 2)}\n`
    if (opts.output) {
      await writeFile(opts.output, json)
      process.stdout.write(`wrote ${opts.output}\n`)
    } else {
      process.stdout.write(json)
    }
  } finally {
    if (opts.stopStack) await run('docker', ['compose', 'down', '-v'], env).catch(() => undefined)
    if (!opts.keepWorkDir && !opts.workDir) await rm(workRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`)
  process.exitCode = 1
})
