// `prosa compile-v2 <provider>` and `prosa compile-all-v2` — Lane 2
// CLI surface. Wraps `runCompileImports` against the five real
// providers (Codex, Claude Code, Cursor, Gemini, Hermes). Lives
// alongside the v1 `prosa compile`/`compile-all` commands; v1 is
// kept until Lane 10.
//
// Discovery roots default to the per-provider conventions:
//   - codex:  $HOME/.codex/sessions
//   - claude: $HOME/.claude/projects
//   - cursor: $HOME/.cursor/chats
//   - gemini: $HOME/.gemini/tmp
//   - hermes: $HOME/.hermes/sessions
//
// Each subcommand accepts `--store <path>` (bundle root) and
// `--root <path>` (discovery root override). `--quiet` suppresses
// the per-provider summary JSON. The bundle is opened, seal happens
// inside `runCompileImports`, and the bundle is closed before exit.

import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

import { initBundle, openBundle } from '@c3-oss/prosa-bundle-v2'
import { runSessionBlobBuild, runTantivyRebuildForBundle } from '@c3-oss/prosa-derived-v2'
import {
  ClaudeProvider,
  CodexProvider,
  CursorProvider,
  GeminiProvider,
  HermesProvider,
  type Provider,
  runCompileImports,
} from '@c3-oss/prosa-importers-v2'
import { Command } from 'commander'

/**
 * Drive the post-seal derived layer (Tantivy index + session-blob
 * packs) for `epoch`. Returns a small summary the caller appends to
 * its JSON output. Failures are surfaced as `error: string` rather
 * than throwing so a derived-layer hiccup doesn't roll back a seal
 * that already committed.
 */
async function buildDerivedForEpoch(opts: {
  storePath: string
  epoch: number
}): Promise<{ tantivy: unknown; sessionBlob: unknown }> {
  let tantivy: unknown
  try {
    tantivy = await runTantivyRebuildForBundle({ bundleRoot: opts.storePath, epoch: opts.epoch })
  } catch (err) {
    tantivy = { error: (err as Error).message }
  }
  let sessionBlob: unknown
  try {
    sessionBlob = await runSessionBlobBuild({ bundleRoot: opts.storePath, epoch: opts.epoch })
  } catch (err) {
    sessionBlob = { error: (err as Error).message }
  }
  return { tantivy, sessionBlob }
}

type ProviderName = 'codex' | 'claude' | 'cursor' | 'gemini' | 'hermes'

function providerFor(name: ProviderName): Provider {
  switch (name) {
    case 'codex':
      return new CodexProvider()
    case 'claude':
      return new ClaudeProvider()
    case 'cursor':
      return new CursorProvider()
    case 'gemini':
      return new GeminiProvider()
    case 'hermes':
      return new HermesProvider()
  }
}

function defaultRootFor(name: ProviderName): string {
  const home = homedir()
  switch (name) {
    case 'codex':
      return resolvePath(home, '.codex', 'sessions')
    case 'claude':
      return resolvePath(home, '.claude', 'projects')
    case 'cursor':
      return resolvePath(home, '.cursor', 'chats')
    case 'gemini':
      return resolvePath(home, '.gemini', 'tmp')
    case 'hermes':
      return resolvePath(home, '.hermes', 'sessions')
  }
}

/** Open the bundle, initialising it if `<store>/head.json` is missing. */
async function openOrInit(storePath: string): Promise<Awaited<ReturnType<typeof openBundle>>> {
  try {
    return await openBundle(storePath)
  } catch (err) {
    // openBundle throws a plain Error with "head.json not found" when
    // the bundle has never been initialised; the underlying syscall's
    // ENOENT is swallowed by an internal `.catch(() => null)`. Fall
    // back to initBundle on either signature.
    const msg = err instanceof Error ? err.message : String(err)
    const errno = (err as NodeJS.ErrnoException).code
    if (errno === 'ENOENT' || /not found/.test(msg)) {
      return await initBundle(storePath)
    }
    throw err
  }
}

export function compileV2Command(): Command {
  return new Command('compile-v2')
    .description('Compile a single provider into a bundle v2 store (alongside v1).')
    .argument('<provider>', 'one of: codex, claude, cursor, gemini, hermes')
    .requiredOption('--store <path>', 'bundle directory')
    .option('--root <path>', 'discovery root (defaults to the per-provider $HOME convention)')
    .option('--quiet', 'suppress the per-provider summary JSON', false)
    .option(
      '--no-build-derived',
      'skip the post-seal derived-layer build (Tantivy index + session-blob packs). Defaults to true so `index-v2 status` reports `ready_for_read: true` after compile.',
    )
    .action(
      async (
        providerName: string,
        options: { store: string; root?: string; quiet: boolean; buildDerived: boolean },
      ) => {
        const name = providerName.toLowerCase() as ProviderName
        if (!['codex', 'claude', 'cursor', 'gemini', 'hermes'].includes(name)) {
          process.stderr.write(`unknown provider: ${providerName}\n`)
          process.exit(2)
        }
        const storePath = resolvePath(options.store)
        const discoveryRoot = options.root !== undefined ? resolvePath(options.root) : defaultRootFor(name)
        const bundle = await openOrInit(storePath)
        let derived: { tantivy: unknown; sessionBlob: unknown } | null = null
        try {
          const result = await runCompileImports({
            bundle,
            providers: [{ provider: providerFor(name), root: discoveryRoot }],
          })
          if (options.buildDerived) {
            derived = await buildDerivedForEpoch({ storePath, epoch: result.sealedEpoch })
          }
          if (!options.quiet) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  sealedEpoch: result.sealedEpoch,
                  perProvider: result.perProvider,
                  fixups: result.fixups.length,
                  derived,
                },
                null,
                2,
              )}\n`,
            )
          }
        } finally {
          await bundle.close()
        }
      },
    )
}

export function compileAllV2Command(): Command {
  return new Command('compile-all-v2')
    .description('Compile every supported provider into a bundle v2 store in one epoch.')
    .requiredOption('--store <path>', 'bundle directory')
    .option('--codex-root <path>', 'discovery root for the Codex provider (defaults to $HOME/.codex/sessions)')
    .option('--claude-root <path>', 'discovery root for the Claude Code provider (defaults to $HOME/.claude/projects)')
    .option('--cursor-root <path>', 'discovery root for the Cursor provider (defaults to $HOME/.cursor/chats)')
    .option('--gemini-root <path>', 'discovery root for the Gemini CLI provider (defaults to $HOME/.gemini/tmp)')
    .option('--hermes-root <path>', 'discovery root for the Hermes provider (defaults to $HOME/.hermes/sessions)')
    .option('--quiet', 'suppress the per-provider summary JSON', false)
    .option(
      '--no-build-derived',
      'skip the post-seal derived-layer build (Tantivy index + session-blob packs). Defaults to true so `index-v2 status` reports `ready_for_read: true` after compile.',
    )
    .action(
      async (options: {
        store: string
        codexRoot?: string
        claudeRoot?: string
        cursorRoot?: string
        geminiRoot?: string
        hermesRoot?: string
        quiet: boolean
        buildDerived: boolean
      }) => {
        const storePath = resolvePath(options.store)
        const providers: { provider: Provider; root: string }[] = [
          { provider: new CodexProvider(), root: resolvePath(options.codexRoot ?? defaultRootFor('codex')) },
          { provider: new ClaudeProvider(), root: resolvePath(options.claudeRoot ?? defaultRootFor('claude')) },
          { provider: new CursorProvider(), root: resolvePath(options.cursorRoot ?? defaultRootFor('cursor')) },
          { provider: new GeminiProvider(), root: resolvePath(options.geminiRoot ?? defaultRootFor('gemini')) },
          { provider: new HermesProvider(), root: resolvePath(options.hermesRoot ?? defaultRootFor('hermes')) },
        ]
        const bundle = await openOrInit(storePath)
        let derived: { tantivy: unknown; sessionBlob: unknown } | null = null
        try {
          const result = await runCompileImports({ bundle, providers })
          if (options.buildDerived) {
            derived = await buildDerivedForEpoch({ storePath, epoch: result.sealedEpoch })
          }
          if (!options.quiet) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  sealedEpoch: result.sealedEpoch,
                  perProvider: result.perProvider,
                  fixups: result.fixups.length,
                  derived,
                },
                null,
                2,
              )}\n`,
            )
          }
        } finally {
          await bundle.close()
        }
      },
    )
}
