import { Alert, StatusMessage } from '@inkjs/ui'
import { Box, render } from 'ink'

/**
 * Centralized predicate for "should we render Ink to stdout?" — true only when
 * stdout is an interactive TTY. Callers also gate on `--json`/`--quiet` flags
 * before calling Ink so machine-readable output never leaks formatting.
 */
export function shouldUseInk(): boolean {
  return Boolean(process.stdout.isTTY)
}

/** Render a one-shot `<StatusMessage>` and wait for Ink to flush + exit. */
export async function inkStatus(variant: 'success' | 'error' | 'warning' | 'info', message: string): Promise<void> {
  const app = render(<StatusMessage variant={variant}>{message}</StatusMessage>, {
    stdout: process.stdout,
    exitOnCtrlC: false,
  })
  app.unmount()
  await app.waitUntilExit().catch(() => undefined)
}

/** Render a multi-line `<Alert>` and wait for Ink to flush + exit. */
export async function inkAlert(
  variant: 'info' | 'success' | 'error' | 'warning',
  title: string,
  body: string,
): Promise<void> {
  const app = render(
    <Box flexDirection="column">
      <Alert variant={variant} title={title}>
        {body}
      </Alert>
    </Box>,
    { stdout: process.stdout, exitOnCtrlC: false },
  )
  app.unmount()
  await app.waitUntilExit().catch(() => undefined)
}

/**
 * Render Ink to stdout when it's a TTY and the caller didn't opt out
 * (`--json`/`--quiet`); otherwise fall back to plain `process.stdout.write`.
 * Keeps every command's branching one line.
 */
export async function emitStatus(opts: {
  json?: boolean
  quiet?: boolean
  variant: 'success' | 'error' | 'warning' | 'info'
  message: string
  plain: string
}): Promise<void> {
  if (opts.json || opts.quiet || !shouldUseInk()) {
    process.stdout.write(opts.plain)
    return
  }
  await inkStatus(opts.variant, opts.message)
}
