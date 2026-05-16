import { ProgressBar, Spinner, StatusMessage } from '@inkjs/ui'
import { Box, Text, render } from 'ink'
import type React from 'react'
import { useEffect, useState } from 'react'
import { shouldUseInk } from './messages.js'

/**
 * Live phase + progress for `prosa sync`. The driver (sync command) emits
 * events; the React component re-renders to reflect them. We deliberately
 * keep the state machine tiny — the existing imperative pipeline owns the
 * work, this is presentation only.
 */
export type SyncPhase =
  | { kind: 'idle' }
  | { kind: 'handshake' }
  | { kind: 'plan' }
  | { kind: 'upload'; completed: number; total: number }
  | { kind: 'commit' }
  | { kind: 'verify' }
  | { kind: 'cleanup' }
  | { kind: 'done' }

/** Mutable handle controlling the sync progress Ink view. */
export interface SyncProgressHandle {
  setPhase(phase: SyncPhase): void
  /** Unmount the Ink instance. Safe to call multiple times. */
  stop(): Promise<void>
  /** True iff Ink is actually rendering (TTY + not disabled). */
  active: boolean
}

interface SyncProgressViewProps {
  initial: SyncPhase
  subscribe: (cb: (phase: SyncPhase) => void) => () => void
}

function SyncProgressView({ initial, subscribe }: SyncProgressViewProps): React.JSX.Element {
  const [phase, setPhase] = useState<SyncPhase>(initial)
  useEffect(() => subscribe(setPhase), [subscribe])

  switch (phase.kind) {
    case 'idle':
      return <Spinner label="Preparing sync…" />
    case 'handshake':
      return <Spinner label="Handshaking with server…" />
    case 'plan':
      return <Spinner label="Planning upload…" />
    case 'upload': {
      const pct = phase.total > 0 ? Math.round((phase.completed / phase.total) * 100) : 0
      return (
        <Box flexDirection="column">
          <Box>
            <ProgressBar value={pct} />
            <Text>{` ${pct}%`}</Text>
          </Box>
          <Text dimColor>{`${phase.completed}/${phase.total} batches`}</Text>
        </Box>
      )
    }
    case 'commit':
      return <Spinner label="Committing batch…" />
    case 'verify':
      return <Spinner label="Verifying remote receipt…" />
    case 'cleanup':
      return <Spinner label="Cleaning up local bundle…" />
    case 'done':
      return <StatusMessage variant="success">Sync complete</StatusMessage>
  }
}

/**
 * Mount the sync progress view. When stdout isn't a TTY or `quiet`/`json` is
 * set, return an inert handle so the caller can drive phase transitions
 * unconditionally — the noop handle is what makes test/scripted output stable.
 */
export function startSyncProgress(opts: { quiet?: boolean; json?: boolean }): SyncProgressHandle {
  if (opts.json || opts.quiet || !shouldUseInk()) {
    return {
      active: false,
      setPhase: () => undefined,
      stop: async () => undefined,
    }
  }

  let current: SyncPhase = { kind: 'idle' }
  const listeners = new Set<(p: SyncPhase) => void>()
  const subscribe = (cb: (p: SyncPhase) => void) => {
    listeners.add(cb)
    cb(current)
    return () => {
      listeners.delete(cb)
    }
  }

  const app = render(<SyncProgressView initial={current} subscribe={subscribe} />, {
    stdout: process.stdout,
    exitOnCtrlC: false,
  })

  let stopped = false
  return {
    active: true,
    setPhase(next) {
      current = next
      for (const l of listeners) l(next)
    },
    async stop() {
      if (stopped) return
      stopped = true
      app.unmount()
      await app.waitUntilExit().catch(() => undefined)
    },
  }
}
