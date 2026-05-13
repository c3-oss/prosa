import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useState } from 'react'
import type { Bundle } from '../core/bundle.js'
import type { SourceTool } from '../core/domain/types.js'
import { type SearchHit, searchFullText } from '../services/search.js'
import { type SessionDetail, type SessionRow, getSession, listSessions } from '../services/sessions.js'
import { clamp, visibleWindow } from './use-visible-window.js'

type Screen = 'sessions' | 'detail' | 'search'
type InputMode = 'normal' | 'search'

interface Props {
  bundle: Bundle
}

const TOOL_FILTERS: (SourceTool | 'all')[] = ['all', 'codex', 'claude', 'gemini', 'cursor']

/** Ink root component for browsing sessions, search hits, and session timelines. */
export function App({ bundle }: Props): React.JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [rows, setRows] = useState<SessionRow[]>([])
  const [selected, setSelected] = useState(0)
  const [screen, setScreen] = useState<Screen>('sessions')
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [detailScroll, setDetailScroll] = useState(0)
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
        setDetail(null)
        setDetailScroll(0)
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
      const totalLines = (detail?.events.length ?? 0) + 8 // rough header height
      if (input === 'j' || key.downArrow) {
        setDetailScroll((s) => clamp(s + 1, 0, Math.max(0, totalLines - detailHeight)))
        return
      }
      if (input === 'k' || key.upArrow) {
        setDetailScroll((s) => clamp(s - 1, 0, Math.max(0, totalLines - detailHeight)))
        return
      }
      if (input === 'G') {
        setDetailScroll(Math.max(0, totalLines - detailHeight))
        return
      }
      if (input === 'g') {
        if (pendingG) {
          setDetailScroll(0)
          setPendingG(false)
        } else {
          setPendingG(true)
          setTimeout(() => setPendingG(false), 500)
        }
        return
      }
      if (key.ctrl && input === 'd') {
        setDetailScroll((s) => clamp(s + Math.floor(detailHeight / 2), 0, totalLines))
        return
      }
      if (key.ctrl && input === 'u') {
        setDetailScroll((s) => clamp(s - Math.floor(detailHeight / 2), 0, totalLines))
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
        setTimeout(() => setPendingG(false), 500)
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
        const d = getSession(bundle, sid)
        if (d) {
          setDetail(d)
          setScreen('detail')
          setDetailScroll(0)
        }
      }
    }
  })

  useEffect(() => {
    if (!statusMessage) return
    const t = setTimeout(() => setStatusMessage(null), 2000)
    return () => clearTimeout(t)
  }, [statusMessage])

  if (screen === 'detail' && detail) {
    return <DetailView detail={detail} scroll={detailScroll} height={detailHeight} />
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
        const realIndex = window.startIndex + i
        const isSelected = realIndex === selected
        return (
          <Box key={row.session_id}>
            <Text color={isSelected ? 'black' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
              {`${isSelected ? '› ' : '  '}${pad(row.start_ts ?? '—', 24)} ${pad(row.source_tool, 7)} ${pad(row.message_count.toString(), 5)} ${pad(row.tool_call_count.toString(), 5)} ${trim(row.cwd_initial ?? '—', 32)} ${trim(row.title ?? row.source_session_id, 30)}`}
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
        const realIndex = window.startIndex + i
        const isSelected = realIndex === selected
        return (
          <Box key={hit.doc_id}>
            <Text color={isSelected ? 'black' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
              {`${isSelected ? '› ' : '  '}${pad(hit.timestamp ?? '—', 24)} ${pad(hit.role ?? '—', 10)} ${trim(hit.session_id ?? '—', 16)} ${trim(hit.snippet.replace(/\s+/g, ' '), 80)}`}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** Render a compact, scrollable session timeline detail view. */
function DetailView({
  detail,
  scroll,
  height,
}: {
  detail: SessionDetail
  scroll: number
  height: number
}): React.JSX.Element {
  const headerLines = [
    `# session ${detail.session.session_id}`,
    `source: ${detail.session.source_tool}  ·  start: ${detail.session.start_ts ?? '—'}`,
    `cwd: ${detail.session.cwd_initial ?? '—'}  ·  branch: ${detail.session.git_branch_initial ?? '—'}`,
    `models: ${detail.session.model_first ?? '?'} → ${detail.session.model_last ?? '?'}`,
    `messages: ${detail.session.message_count}  ·  tool_calls: ${detail.session.tool_call_count}  ·  confidence: ${detail.session.timeline_confidence}`,
    '',
  ]
  const eventLines = detail.events.map((e) => {
    const role = e.role ? `[${e.role}] ` : ''
    const tool = e.tool_name ? ` tool=${e.tool_name}` : ''
    const err = e.is_error === 1 ? ' ERROR' : ''
    const ts = e.timestamp ?? ''
    return `${pad(ts, 24)} ${pad(e.event_type, 18)} ${role}${tool}${err}`
  })
  const allLines = [...headerLines, ...eventLines]
  const slice = allLines.slice(scroll, scroll + height)
  return (
    <Box flexDirection="column" height={height}>
      {slice.map((line, idx) => {
        // Detail lines are content-derived; the (scroll, idx) pair is unique
        // within a render and we don't reorder them, so it's safe as a key.
        const key = `l${scroll + idx}-${line.length}`
        return <Text key={key}>{line}</Text>
      })}
      <Box marginTop={1}>
        <Text dimColor>j/k scroll · gg/G top/bottom · Esc back · q quits from sessions</Text>
      </Box>
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
  mode: 'sessions' | 'search'
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
  return (
    <Box>
      {status ? (
        <Text color="green">{status}</Text>
      ) : (
        <Text dimColor>
          j/k nav · Enter open · / search · s cycle source · R reload · Esc back · q quit
          {mode === 'search' ? '' : ''}
        </Text>
      )}
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
