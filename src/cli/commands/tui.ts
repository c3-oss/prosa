import { Command } from 'commander';
import { defaultBundlePath } from '../../core/bundle.js';
import { withBundle } from '../bundle.js';

export function tuiCommand(): Command {
  return new Command('tui')
    .description('Open the interactive Ink-based explorer.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (options: { store: string }) => {
      // Lazy-load Ink/React/App to keep `prosa --help` startup fast.
      const [{ render }, React, { App }] = await Promise.all([
        import('ink'),
        import('react'),
        import('../../tui/App.js'),
      ]);
      await withBundle(options.store, async (bundle) => {
        // eslint-disable-next-line no-console
        console.clear();
        const app = render(React.createElement(App, { bundle }));
        await app.waitUntilExit();
      });
    });
}
