import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type ChangeEvent, useEffect, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { formatAbsoluteTime, truncate } from '~/lib/format.js'
import { queryKeys } from '~/lib/query-keys.js'

type SearchHit = {
  id: string
  sessionId: string
  sessionTitle: string | null
  sourceKind: string
  timestamp: string | null
  fieldKind: string
  snippet: string
}

type SearchPage = { rows: SearchHit[]; nextCursor: string | null }

export function ConsoleSearch() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null
  const search = useSearch({ strict: false }) as { q?: string; cursor?: string }
  const navigate = useNavigate()

  const initialQuery = typeof search.q === 'string' ? search.q : ''
  const [draft, setDraft] = useState(initialQuery)
  const [submitted, setSubmitted] = useState(initialQuery)
  const cursor = typeof search.cursor === 'string' ? search.cursor : null

  useEffect(() => {
    setDraft(initialQuery)
    setSubmitted(initialQuery)
  }, [initialQuery])

  function onSubmit(event: ChangeEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitted(draft)
    navigate({
      to: '/console/search',
      search: draft ? { q: draft } : {},
    })
  }

  const enabled = Boolean(tenantId && submitted.length > 0)

  const results = useQuery({
    enabled,
    queryKey:
      tenantId && submitted
        ? queryKeys.searchQuery(tenantId, { q: submitted, cursor })
        : ['search', 'query', 'no-tenant'],
    queryFn: async (): Promise<SearchPage> => api.search.query.query({ q: submitted, ...(cursor ? { cursor } : {}) }),
    placeholderData: keepPreviousData,
  })

  const rows = results.data?.rows ?? []
  const nextCursor = results.data?.nextCursor ?? null

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Search</h1>
          <p>Search across promoted search_doc rows for this tenant.</p>
        </div>
      </header>
      <div className="console-content" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <form
          onSubmit={onSubmit as unknown as React.FormEventHandler<HTMLFormElement>}
          aria-label="Search query form"
          style={{ display: 'flex', gap: 'var(--space-2)' }}
        >
          <input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="search snippets, tool inputs, message text…"
            aria-label="Search query"
            style={{
              flex: 1,
              background: 'var(--color-bg-elevated)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              fontSize: 'var(--font-size-base)',
            }}
          />
          <Button type="submit" variant="primary">
            Search
          </Button>
        </form>
        {!tenantId ? (
          <EmptyState title="Pick a tenant to continue" description="Search is tenant-scoped." />
        ) : !submitted ? (
          <EmptyState
            title="Enter a query to start"
            description="Use the box above. Results are paginated by cursor and stable across reloads via the URL."
          />
        ) : results.error ? (
          <EmptyState
            title="Search failed"
            description={results.error instanceof Error ? results.error.message : 'Unknown error'}
          />
        ) : rows.length === 0 && !results.isFetching ? (
          <EmptyState title="No results" description={`No promoted search_doc rows match "${submitted}" yet.`} />
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            {rows.map((hit) => (
              <li
                key={hit.id}
                style={{
                  background: 'var(--color-panel)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-4)',
                }}
              >
                <header
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-faint)',
                    marginBottom: 'var(--space-2)',
                  }}
                >
                  <span>
                    {hit.sourceKind} · {hit.fieldKind}
                  </span>
                  <span>{formatAbsoluteTime(hit.timestamp)}</span>
                </header>
                <p style={{ margin: 0, color: 'var(--color-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {truncate(hit.snippet, 320)}
                </p>
                <footer style={{ marginTop: 'var(--space-2)' }}>
                  <Link
                    to="/console/sessions/$sessionId"
                    params={{ sessionId: hit.sessionId }}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
                  >
                    {hit.sessionTitle ?? hit.sessionId}
                  </Link>
                </footer>
              </li>
            ))}
          </ul>
        )}
        {nextCursor ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => navigate({ to: '/console/search', search: { q: submitted, cursor: nextCursor } })}
            disabled={results.isFetching}
          >
            {results.isFetching ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
    </>
  )
}
