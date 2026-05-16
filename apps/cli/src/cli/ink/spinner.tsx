import { Spinner } from '@inkjs/ui'
import { Box, Text, render } from 'ink'
import { shouldUseInk } from './messages.js'

/**
 * Run `task()` while showing a spinner with `label`. When stdout isn't a TTY,
 * skip Ink and just run the task — keeps piped/scripted output clean.
 */
export async function withSpinner<T>(label: string, task: () => Promise<T>, opts?: { quiet?: boolean }): Promise<T> {
  if (opts?.quiet || !shouldUseInk()) {
    return task()
  }
  const app = render(
    <Box>
      <Spinner label={label} />
    </Box>,
    { stdout: process.stdout, exitOnCtrlC: false },
  )
  try {
    return await task()
  } finally {
    app.unmount()
    // waitUntilExit can hang if stdin isn't tty; ignore failure
    await app.waitUntilExit().catch(() => undefined)
  }
}

/** Render a single static line via Ink (used for one-off info banners). */
export async function inkLine(text: string, color?: 'gray' | 'cyan' | 'yellow'): Promise<void> {
  const app = render(<Text color={color}>{text}</Text>, { stdout: process.stdout, exitOnCtrlC: false })
  app.unmount()
  await app.waitUntilExit().catch(() => undefined)
}
