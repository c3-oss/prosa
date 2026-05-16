import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useAppContext } from '~/app/providers.js'
import { queryKeys } from '~/lib/query-keys.js'

/** Initial CAS fetch budget. 64KB keeps the typical "expand" snappy. */
const DEFAULT_MAX_BYTES = 64 * 1024
/** Upper cap on a single fetch; matches the API procedure's hard maximum. */
const SHOW_ALL_MAX_BYTES = 1_900_000

export type CasTextProps = {
  objectId: string
  /** Initial byte budget. Defaults to 64KB. */
  maxBytes?: number
  /** Optional className for the outer `<pre>`. */
  className?: string
}

/**
 * Lazy fetch for CAS-backed block bodies. Renders a loading skeleton, then
 * the decoded text. If the response is truncated the user can request a
 * larger window (capped at the API's `maxBytes` ceiling).
 */
export function CasText({ objectId, maxBytes = DEFAULT_MAX_BYTES, className }: CasTextProps) {
  // The CAS text needs a tenant for the query key. We read it from the app
  // context (not the auth context) so the component renders inside tests
  // that skip the auth provider.
  const { api, tenantId } = useAppContext()
  const [budget, setBudget] = useState(maxBytes)
  const query = useQuery({
    enabled: Boolean(tenantId && objectId),
    queryKey: tenantId ? queryKeys.artifactText(tenantId, { objectId, maxBytes: budget }) : ['cas', 'no-tenant'],
    queryFn: () => api.artifacts.getText.query({ objectId, maxBytes: budget }),
  })

  if (!tenantId) return null
  if (query.isLoading) {
    return <div className="transcript-cas-loading" aria-busy="true" aria-live="polite" />
  }
  if (query.error) {
    return (
      <p className="transcript-cas-error">
        Failed to load: {query.error instanceof Error ? query.error.message : 'unknown error'}
      </p>
    )
  }
  const data = query.data
  if (!data) return null
  return (
    <div>
      <pre className={className ?? 'transcript-tool-output'}>{data.text}</pre>
      {data.truncated && budget < SHOW_ALL_MAX_BYTES ? (
        <button
          type="button"
          className="transcript-show-full-btn"
          onClick={() => setBudget(SHOW_ALL_MAX_BYTES)}
          disabled={query.isFetching}
        >
          {query.isFetching ? 'Loading…' : 'Show all'}
        </button>
      ) : null}
    </div>
  )
}
