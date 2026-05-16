import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import {
  DEFAULT_FILTERS,
  SessionsFilterBar,
  SessionsFilterToolbar,
  type SessionsFilters,
  countActiveFilters,
} from '~/components/console/sessions-filter-bar.js'
import { type SessionRow, SessionsTable } from '~/components/console/sessions-table.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { queryKeys } from '~/lib/query-keys.js'

type SessionsPage = {
  rows: SessionRow[]
  nextCursor: string | null
}

function toIsoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString()
}

// Persist the filter drawer state across reloads. localStorage may be unavailable
// (private mode, SSR-ish prerender) so we wrap both read and write in try/catch.
const FILTERS_OPEN_STORAGE_KEY = 'prosa:sessions-filters:open'

function readFiltersOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(FILTERS_OPEN_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeFiltersOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(FILTERS_OPEN_STORAGE_KEY, open ? 'true' : 'false')
  } catch {
    // ignore — non-critical UI preference
  }
}

function buildListInput(filters: SessionsFilters, cursor: string | null) {
  return {
    limit: 50,
    ...(cursor ? { cursor } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.sourceKinds.length > 0 ? { sourceKinds: filters.sourceKinds } : {}),
    ...(toIsoOrUndefined(filters.since) ? { since: toIsoOrUndefined(filters.since) } : {}),
    ...(toIsoOrUndefined(filters.until) ? { until: toIsoOrUndefined(filters.until) } : {}),
  }
}

export function ConsoleSessions() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null
  const [filters, setFilters] = useState<SessionsFilters>(DEFAULT_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => readFiltersOpen())
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([])

  const toggleFiltersOpen = useCallback(() => {
    setFiltersOpen((prev) => {
      const next = !prev
      writeFiltersOpen(next)
      return next
    })
  }, [])

  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters])

  // Reset cursor whenever filters change. Biome's exhaustive-deps lint flags
  // `filters` as unused on the rule's behalf, but we deliberately rerun this
  // effect on the entire filters object so any field change resets pagination.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters object is the trigger by design
  useEffect(() => {
    setCursor(null)
    setCursorStack([])
  }, [filters])

  const listInput = useMemo(() => buildListInput(filters, cursor), [filters, cursor])

  const sessions = useQuery({
    enabled: Boolean(tenantId),
    queryKey: tenantId ? queryKeys.sessionsList(tenantId, listInput) : ['sessions', 'list', 'no-tenant'],
    queryFn: async (): Promise<SessionsPage> => api.sessions.list.query(listInput),
    placeholderData: keepPreviousData,
  })

  const count = useQuery({
    enabled: Boolean(tenantId),
    queryKey: tenantId
      ? queryKeys.sessionsCount(tenantId, {
          q: filters.q,
          sourceKinds: filters.sourceKinds,
          since: toIsoOrUndefined(filters.since) ?? null,
          until: toIsoOrUndefined(filters.until) ?? null,
        })
      : ['sessions', 'count', 'no-tenant'],
    queryFn: async (): Promise<{ count: number }> =>
      api.sessions.count.query({
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.sourceKinds.length > 0 ? { sourceKinds: filters.sourceKinds } : {}),
        ...(toIsoOrUndefined(filters.since) ? { since: toIsoOrUndefined(filters.since) } : {}),
        ...(toIsoOrUndefined(filters.until) ? { until: toIsoOrUndefined(filters.until) } : {}),
      }),
  })

  function pageForward() {
    if (!sessions.data?.nextCursor) return
    setCursorStack((stack) => [...stack, cursor])
    setCursor(sessions.data.nextCursor)
  }

  function pageBack() {
    setCursorStack((stack) => {
      if (stack.length === 0) {
        setCursor(null)
        return stack
      }
      const previous = stack[stack.length - 1] ?? null
      setCursor(previous)
      return stack.slice(0, -1)
    })
  }

  const rows = sessions.data?.rows ?? []
  const total = count.data?.count ?? null
  const showEmpty = !sessions.isLoading && rows.length === 0 && cursor === null

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Sessions</h1>
          <p>Promoted sessions for this tenant.</p>
        </div>
      </header>
      <div className="console-content">
        {!tenantId ? (
          <EmptyState title="Pick a tenant to continue" description="Sessions are tenant-scoped." />
        ) : sessions.error ? (
          <EmptyState
            title="Could not load sessions"
            description={sessions.error instanceof Error ? sessions.error.message : 'Unknown error'}
          />
        ) : (
          <>
            <SessionsFilterToolbar
              open={filtersOpen}
              onToggle={toggleFiltersOpen}
              activeCount={activeFilterCount}
              right={
                total == null
                  ? null
                  : `${total.toLocaleString()} session${total === 1 ? '' : 's'} match the current filters.`
              }
            />
            <SessionsFilterBar value={filters} onChange={setFilters} open={filtersOpen} />
            {showEmpty ? (
              <EmptyState
                title="No promoted sessions yet"
                description="Run the CLI on each device, then push to this tenant. The console only shows verified, promoted data."
                code="prosa auth login && prosa sync push"
              />
            ) : (
              <>
                <SessionsTable rows={rows} loading={sessions.isLoading || sessions.isFetching} />
                <nav
                  aria-label="Sessions pagination"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: 'var(--space-4)',
                  }}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={pageBack}
                    disabled={cursorStack.length === 0 && cursor === null}
                  >
                    ← Newer
                  </Button>
                  <span
                    style={{
                      color: 'var(--color-text-faint)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--font-size-xs)',
                    }}
                  >
                    {sessions.isFetching ? 'Loading…' : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={pageForward}
                    disabled={!sessions.data?.nextCursor}
                  >
                    Older →
                  </Button>
                </nav>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
