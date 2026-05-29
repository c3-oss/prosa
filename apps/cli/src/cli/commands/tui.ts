import { defaultBundlePath } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { resolveReadAuthorityOrFailClosed } from '../auth/routing.js'
import { withBundle } from '../bundle.js'

/** Create the `prosa v1 tui` command that opens the Ink session explorer. */
export function tuiCommand(): Command {
  return new Command('tui')
    .description('Open the interactive Ink-based explorer.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--local', 'read the local bundle even if this store is remote-authoritative', false)
    .action(async (options: { store: string; local: boolean }) => {
      await resolveReadAuthorityOrFailClosed({
        commandName: 'prosa v1 tui',
        storePath: options.store,
        forceLocal: options.local,
        remoteSupported: false,
      })
      // Lazy-load Ink/React/App to keep `prosa --help` startup fast.
      const [{ render }, React, { App }] = await Promise.all([
        import('ink'),
        import('react'),
        import('../../tui/App.js'),
      ])
      await withBundle(options.store, async (bundle) => {
        // eslint-disable-next-line no-console
        console.clear()
        const app = render(React.createElement(App, { bundle }))
        await app.waitUntilExit()
      })
    })
}
