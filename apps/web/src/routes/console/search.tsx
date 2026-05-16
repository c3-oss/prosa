import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitted(draft)
    navigate({ to: '/console/search', search: draft ? { q: draft } : {} })
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
      <div className="console-content">
        <form onSubmit={onSubmit} aria-label="Search query form" className="console-search-form">
          <div className="console-input-with-icon">
            <Search size={15} aria-hidden="true" className="console-input-icon" />
            <input
              className="console-input"
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="search snippets, tool inputs, message text…"
              aria-label="Search query"
            />
          </div>
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>
        {submitted && rows.length > 0 ? (
          <p className="console-faint console-results-count">
            {rows.length}
            {nextCursor ? '+' : ''} hits for "{submitted}"
          </p>
        ) : null}
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
          <ul className="console-results-list">
            {rows.map((hit) => (
              <li key={hit.id} className="console-result-card">
                <header className="console-result-meta">
                  <span>
                    {hit.sourceKind} · {hit.fieldKind}
                  </span>
                  <span>{formatAbsoluteTime(hit.timestamp)}</span>
                </header>
                <p className="console-result-body">{truncate(hit.snippet, 320)}</p>
                <footer className="console-result-footer">
                  <Link to="/console/sessions/$sessionId" params={{ sessionId: hit.sessionId }}>
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
