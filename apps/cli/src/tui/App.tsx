import { spawnSync } from 'node:child_process'
import {
  type Bundle,
  type SearchHit,
  type SessionRow,
  type SessionTranscript,
  type SourceTool,
  listSessions,
  loadTranscript,
  searchFullText,
} from '@c3-oss/prosa-core'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useState } from 'react'
import { openInPager } from './open-in-pager.js'
import { TranscriptView } from './transcript-view.js'
import { type FlatLine, flattenTranscript } from './use-flat-lines.js'
import { clamp, visibleWindow } from './use-visible-window.js'

type Screen = 'sessions' | 'detail' | 'search'
type InputMode = 'normal' | 'search'

interface Props {
  bundle: Bundle
}

// Hand-rolled cycle order for the `s` shortcut; not derived from SOURCE_TOOLS
// because the canonical ordering there is alphabetical-ish and would surprise
// people pressing `s` (the test suite locks the order down).
const TOOL_FILTERS: readonly (SourceTool | 'all')[] = ['all', 'codex', 'claude', 'gemini', 'cursor', 'hermes']
/** Vim's `gg` requires two presses; the second must land within this window. */
const VIM_DOUBLE_PRESS_MS = 500
/** Tool-output truncation budget used when flattening transcripts for the TUI. */
const TRANSCRIPT_MAX_OUTPUT_LINES = 40

/** Ink root component for browsing sessions, search hits, and session timelines. */
export function App({ bundle }: Props): React.JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [rows, setRows] = useState<SessionRow[]>([])
  const [selected, setSelected] = useState(0)
  const [screen, setScreen] = useState<Screen>('sessions')
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [transcriptScroll, setTranscriptScroll] = useState(0)
  const [transcriptSelectedLine, setTranscriptSelectedLine] = useState(0)
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(() => new Set())
  const [showThinkingGlobal, setShowThinkingGlobal] = useState(false)
  const [toolFilterIdx, setToolFilterIdx] = useState(0)
  const [inputMode, setInputMode] = useState<InputMode>('normal')
  const [searchBuffer, setSearchBuffer] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [pendingG, setPendingG] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const termHeight = stdout?.rows ?? 24
  const listHeight = Math.max(5, termHeight - 6)
  const detailHeight = Math.max(5, termHeight - 4)

  const toolFilter = TOOL_FILTERS[toolFilterIdx]

  // Reload sessions whenever the active filter changes.
  useEffect(() => {
    const filtered = listSessions(bundle, {
      sourceTool: toolFilter === 'all' ? undefined : (toolFilter as SourceTool),
      limit: 500,
    })
    setRows(filtered)
    setSelected(0)
  }, [bundle, toolFilter])

  const visible = useMemo(
    () => visibleWindow({ total: rows.length, selectedIndex: selected, height: listHeight }),
    [rows.length, selected, listHeight],
  )

  // Recompute the flat line list whenever the transcript or any flag affecting
  // expansion changes. Empty array when no transcript is loaded.
  const flatLines: FlatLine[] = useMemo(() => {
    if (!transcript) return []
    return flattenTranscript(transcript, {
      showThinking: showThinkingGlobal,
      expandedTurns,
      maxOutputLines: TRANSCRIPT_MAX_OUTPUT_LINES,
    })
  }, [transcript, showThinkingGlobal, expandedTurns])

  // Keep the selected line in view as it moves; mirrors `visibleWindow` but
  // for line-based navigation rather than a centered window.
  useEffect(() => {
    const usableHeight = Math.max(1, detailHeight - 1)
    setTranscriptScroll((s) => {
      if (transcriptSelectedLine < s) return transcriptSelectedLine
      const lastVisible = s + usableHeight - 1
      if (transcriptSelectedLine > lastVisible) return transcriptSelectedLine - usableHeight + 1
      return s
    })
  }, [transcriptSelectedLine, detailHeight])

  useInput((input, key) => {
    if (inputMode === 'search') {
      if (key.escape) {
        setInputMode('normal')
        setSearchBuffer('')
        return
      }
      if (key.return) {
        if (searchBuffer.trim().length > 0) {
          const hits = searchFullText(bundle, { query: searchBuffer.trim(), limit: 200 })
          setSearchHits(hits)
          setScreen('search')
          setSelected(0)
        }
        setInputMode('normal')
        return
      }
      if (key.backspace || key.delete) {
        setSearchBuffer((b) => b.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchBuffer((b) => b + input)
      }
      return
    }

    // ---- normal mode ----
    if (input === 'q' && screen === 'sessions') {
      exit()
      return
    }

    if (key.escape) {
      if (screen === 'detail' || screen === 'search') {
        setScreen('sessions')
        setTranscript(null)
        setTranscriptScroll(0)
        setTranscriptSelectedLine(0)
        setExpandedTurns(new Set())
        setSelected(0)
      }
      return
    }

    if (input === '/') {
      setInputMode('search')
      setSearchBuffer('')
      return
    }

    if (input === 's' && screen === 'sessions') {
      setToolFilterIdx((i) => (i + 1) % TOOL_FILTERS.length)
      return
    }

    if (input === 'R') {
      // Reload current view.
      if (screen === 'sessions' || screen === 'search') {
        const reloaded = listSessions(bundle, {
          sourceTool: toolFilter === 'all' ? undefined : (toolFilter as SourceTool),
          limit: 500,
        })
        setRows(reloaded)
        setStatusMessage(`reloaded ${reloaded.length} sessions`)
      }
      return
    }

    // Navigation works in any list-like screen.
    const length = screen === 'sessions' ? rows.length : screen === 'search' ? searchHits.length : 0

    if (screen === 'detail') {
      const totalLines = flatLines.length
      const maxIndex = Math.max(0, totalLines - 1)
      const usableHeight = Math.max(1, detailHeight - 1)

      if (input === 'j' || key.downArrow) {
        setTranscriptSelectedLine((i) => clamp(i + 1, 0, maxIndex))
        return
      }
      if (input === 'k' || key.upArrow) {
        setTranscriptSelectedLine((i) => clamp(i - 1, 0, maxIndex))
        return
      }
      if (input === 'J') {
        setTranscriptSelectedLine((i) => nextTurnHeader(flatLines, i, 1, maxIndex))
        return
      }
      if (input === 'K') {
        setTranscriptSelectedLine((i) => nextTurnHeader(flatLines, i, -1, maxIndex))
        return
      }
      if (input === 'G') {
        setTranscriptSelectedLine(maxIndex)
        return
      }
      if (input === 'g') {
        if (pendingG) {
          setTranscriptSelectedLine(0)
          setTranscriptScroll(0)
          setPendingG(false)
        } else {
          setPendingG(true)
          setTimeout(() => setPendingG(false), VIM_DOUBLE_PRESS_MS)
        }
        return
      }
      if (key.ctrl && input === 'd') {
        setTranscriptSelectedLine((i) => clamp(i + Math.floor(usableHeight / 2), 0, maxIndex))
        return
      }
      if (key.ctrl && input === 'u') {
        setTranscriptSelectedLine((i) => clamp(i - Math.floor(usableHeight / 2), 0, maxIndex))
        return
      }
      if (key.return || input === 'e') {
        const line = flatLines[transcriptSelectedLine]
        if (line && line.turnIndex != null) {
          setExpandedTurns((prev) => toggleSet(prev, line.turnIndex as number))
        }
        return
      }
      if (input === 't') {
        setShowThinkingGlobal((b) => !b)
        return
      }
      if (input === 'o') {
        const line = flatLines[transcriptSelectedLine]
        if (line?.objectId) {
          const objectId = line.objectId
          void openInPager(bundle, objectId)
            .then(() => setStatusMessage('opened in pager'))
            .catch((err: Error) => setStatusMessage(err.message))
        }
        return
      }
      if (input === 'c') {
        const line = flatLines[transcriptSelectedLine]
        if (line) {
          const ok = copyToClipboard(line.text)
          setStatusMessage(ok ? 'copied' : 'clipboard unavailable')
        }
        return
      }
      return
    }

    if (length === 0) return

    if (input === 'j' || key.downArrow) {
      setSelected((i) => clamp(i + 1, 0, length - 1))
      return
    }
    if (input === 'k' || key.upArrow) {
      setSelected((i) => clamp(i - 1, 0, length - 1))
      return
    }
    if (input === 'G') {
      setSelected(length - 1)
      return
    }
    if (input === 'g') {
      if (pendingG) {
        setSelected(0)
        setPendingG(false)
      } else {
        setPendingG(true)
        setTimeout(() => setPendingG(false), VIM_DOUBLE_PRESS_MS)
      }
      return
    }
    if (key.ctrl && input === 'd') {
      setSelected((i) => clamp(i + Math.floor(listHeight / 2), 0, length - 1))
      return
    }
    if (key.ctrl && input === 'u') {
      setSelected((i) => clamp(i - Math.floor(listHeight / 2), 0, length - 1))
      return
    }
    if (key.return) {
      const sid = screen === 'sessions' ? rows[selected]?.session_id : searchHits[selected]?.session_id
      if (sid) {
        // loadTranscript is async; fire and update on resolve. We switch the
        // screen optimistically so the user sees an empty frame instead of
        // a frozen list, then the transcript snaps in.
        setScreen('detail')
        setTranscript(null)
        setTranscriptScroll(0)
        setTranscriptSelectedLine(0)
        setExpandedTurns(new Set())
        void (async () => {
          try {
            const t = await loadTranscript(bundle, sid)
            if (t) setTranscript(t)
            else setStatusMessage(`session not found: ${sid}`)
          } catch (err) {
            setStatusMessage(`load failed: ${(err as Error).message}`)
          }
        })()
      }
    }
  })

  useEffect(() => {
    if (!statusMessage) return
    const t = setTimeout(() => setStatusMessage(null), 2000)
    return () => clearTimeout(t)
  }, [statusMessage])

  if (screen === 'detail') {
    return (
      <Box flexDirection="column">
        {transcript ? (
          <TranscriptView
            transcript={transcript}
            lines={flatLines}
            height={detailHeight}
            scroll={transcriptScroll}
            selectedLine={transcriptSelectedLine}
            showThinking={showThinkingGlobal}
            expandedTurns={expandedTurns}
            maxOutputLines={TRANSCRIPT_MAX_OUTPUT_LINES}
          />
        ) : (
          <Box height={detailHeight}>
            <Text dimColor>loading transcript…</Text>
          </Box>
        )}
        <HelpBar mode="detail" inputMode={inputMode} searchBuffer={searchBuffer} status={statusMessage} />
      </Box>
    )
  }

  if (screen === 'search') {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>
            search:{' '}
          </Text>
          <Text>{searchHits.length} hits</Text>
        </Box>
        <SearchList hits={searchHits} selected={selected} height={listHeight} />
        <HelpBar mode="search" inputMode={inputMode} searchBuffer={searchBuffer} status={statusMessage} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <FilterBar toolFilter={toolFilter} count={rows.length} />
      <SessionList rows={rows} selected={selected} window={visible} height={listHeight} />
      <HelpBar mode="sessions" inputMode={inputMode} searchBuffer={searchBuffer} status={statusMessage} />
    </Box>
  )
}

/** Render the active source filter and session count above the list. */
function FilterBar({
  toolFilter,
  count,
}: {
  toolFilter: SourceTool | 'all' | undefined
  count: number
}): React.JSX.Element {
  return (
    <Box>
      <Text color="cyan" bold>
        prosa
      </Text>
      <Text> · sessions</Text>
      <Text dimColor> · </Text>
      <Text>source: </Text>
      <Text color="yellow">{toolFilter}</Text>
      <Text dimColor> · </Text>
      <Text>count: </Text>
      <Text color="green">{count}</Text>
    </Box>
  )
}

function formatSessionRow(row: SessionRow, isSelected: boolean): string {
  const cursor = isSelected ? '› ' : '  '
  const ts = pad(row.start_ts ?? '—', 24)
  const tool = pad(row.source_tool, 7)
  const messages = pad(row.message_count.toString(), 5)
  const toolCalls = pad(row.tool_call_count.toString(), 5)
  const cwd = trim(row.cwd_initial ?? '—', 32)
  const title = trim(row.title ?? row.source_session_id, 30)
  return `${cursor}${ts} ${tool} ${messages} ${toolCalls} ${cwd} ${title}`
}

function formatSearchHit(hit: SearchHit, isSelected: boolean): string {
  const cursor = isSelected ? '› ' : '  '
  const ts = pad(hit.timestamp ?? '—', 24)
  const role = pad(hit.role ?? '—', 10)
  const sessionId = trim(hit.session_id ?? '—', 16)
  const snippet = trim(hit.snippet.replace(/\s+/g, ' '), 80)
  return `${cursor}${ts} ${role} ${sessionId} ${snippet}`
}

/** Toggle membership of `value` in `prev`, returning a new Set so React sees a change. */
function toggleSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/**
 * Find the next/previous `turn-header` row from `from`. `dir` is +1 (forward)
 * or -1 (back). Returns `from` if nothing else matches so the cursor doesn't
 * jump unexpectedly.
 */
function nextTurnHeader(lines: FlatLine[], from: number, dir: 1 | -1, maxIndex: number): number {
  for (let i = from + dir; i >= 0 && i <= maxIndex; i += dir) {
    if (lines[i]?.kind === 'turn-header') return i
  }
  return from
}

/**
 * Best-effort clipboard copy via `pbcopy` (darwin) or `xclip` (linux).
 * Returns false when no clipboard tool is reachable so the caller can show
 * a hint instead of pretending it worked.
 */
function copyToClipboard(text: string): boolean {
  const platform = process.platform
  if (platform === 'darwin') {
    const r = spawnSync('pbcopy', [], { input: text })
    return r.status === 0
  }
  if (platform === 'linux') {
    const r = spawnSync('xclip', ['-selection', 'clipboard'], { input: text })
    return r.status === 0
  }
  return false
}

/** Render the scrollable session list with the selected row highlighted. */
function SessionList({
  rows,
  selected,
  window,
  height,
}: {
  rows: SessionRow[]
  selected: number
  window: { startIndex: number; endIndex: number }
  height: number
}): React.JSX.Element {
  const slice = rows.slice(window.startIndex, window.endIndex)
  return (
    <Box flexDirection="column" height={height}>
      {slice.map((row, i) => {
        const isSelected = window.startIndex + i === selected
        return (
          <Box key={row.session_id}>
            <Text color={isSelected ? 'black' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
              {formatSessionRow(row, isSelected)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** Render search hits using the same list navigation model as sessions. */
function SearchList({
  hits,
  selected,
  height,
}: {
  hits: SearchHit[]
  selected: number
  height: number
}): React.JSX.Element {
  const window = visibleWindow({ total: hits.length, selectedIndex: selected, height })
  const slice = hits.slice(window.startIndex, window.endIndex)
  return (
    <Box flexDirection="column" height={height}>
      {slice.map((hit, i) => {
        const isSelected = window.startIndex + i === selected
        return (
          <Box key={hit.doc_id}>
            <Text color={isSelected ? 'black' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
              {formatSearchHit(hit, isSelected)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** Render either the search prompt or the normal-mode shortcut/status bar. */
function HelpBar({
  mode,
  inputMode,
  searchBuffer,
  status,
}: {
  mode: 'sessions' | 'search' | 'detail'
  inputMode: InputMode
  searchBuffer: string
  status: string | null
}): React.JSX.Element {
  if (inputMode === 'search') {
    return (
      <Box>
        <Text color="yellow">/ </Text>
        <Text>{searchBuffer}</Text>
        <Text inverse>_</Text>
        <Text dimColor> · Enter to run · Esc to cancel</Text>
      </Box>
    )
  }
  if (status) {
    return (
      <Box>
        <Text color="green">{status}</Text>
      </Box>
    )
  }
  if (mode === 'detail') {
    return (
      <Box>
        <Text dimColor>
          j/k nav · J/K jumps · Enter expand · e thinking · t toggle all · o open · c copy · Esc back
        </Text>
      </Box>
    )
  }
  return (
    <Box>
      <Text dimColor>j/k nav · Enter open · / search · s cycle source · R reload · Esc back · q quit</Text>
    </Box>
  )
}

/** Pad a string to a fixed display width, truncating overflow. */
function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n)
  return s + ' '.repeat(n - s.length)
}

/** Trim a string to a fixed display width while reserving the last cell for an ellipsis. */
function trim(s: string, n: number): string {
  if (s.length <= n) return pad(s, n)
  return `${s.slice(0, n - 1)}…`
}
