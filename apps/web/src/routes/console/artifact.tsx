import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { Panel } from '~/components/primitives/panel.js'
import { queryKeys } from '~/lib/query-keys.js'

type ArtifactText = {
  id: string
  objectId: string
  contentType: string | null
  bytesReturned: number
  truncated: boolean
  text: string
  kind: 'text' | 'binary'
}

export function ConsoleArtifact() {
  const { artifactId } = useParams({ strict: false }) as { artifactId?: string }
  const { apiV2 } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? null

  const artifact = useQuery({
    enabled: Boolean(tenantId && artifactId),
    queryKey:
      tenantId && artifactId ? queryKeys.artifactText(tenantId, { artifactId }) : ['artifacts', 'getText', 'no-tenant'],
    queryFn: async (): Promise<ArtifactText | null> => {
      if (!artifactId) return null
      const response = await apiV2.v2.artifacts.getText({ artifactId })
      // CQ-153: shim v2 found/found:false union into the existing
      // legacy shape the UI consumes. Miss collapses to null so the
      // existing "Could not load artifact" empty state renders.
      if (!response.found) return null
      return {
        id: response.artifactId,
        objectId: response.objectId,
        contentType: response.contentType,
        bytesReturned: response.bytesReturned,
        truncated: response.truncated,
        text: response.text,
        kind: response.kind,
      }
    },
  })

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Artifact</h1>
          <p>Bounded text preview through artifacts.getText.</p>
        </div>
      </header>
      <div className="console-content">
        {!artifactId ? (
          <EmptyState title="Artifact id missing" />
        ) : !tenantId ? (
          <EmptyState title="Pick a tenant to continue" description="Artifact previews are tenant-scoped." />
        ) : artifact.error ? (
          <EmptyState
            title="Could not load artifact"
            description={artifact.error instanceof Error ? artifact.error.message : 'Unknown error'}
          />
        ) : !artifact.data ? (
          <p style={{ color: 'var(--color-text-muted)' }}>Loading artifact…</p>
        ) : (
          <Panel title={`Artifact ${artifact.data.id}`}>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 'var(--space-2) var(--space-4)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              <dt style={{ color: 'var(--color-text-faint)' }}>object id</dt>
              <dd style={{ margin: 0 }}>{artifact.data.objectId}</dd>
              <dt style={{ color: 'var(--color-text-faint)' }}>content type</dt>
              <dd style={{ margin: 0 }}>{artifact.data.contentType ?? 'unknown'}</dd>
              <dt style={{ color: 'var(--color-text-faint)' }}>kind</dt>
              <dd style={{ margin: 0 }}>{artifact.data.kind}</dd>
              <dt style={{ color: 'var(--color-text-faint)' }}>bytes returned</dt>
              <dd style={{ margin: 0 }}>
                {artifact.data.bytesReturned.toLocaleString()} {artifact.data.truncated ? '(truncated)' : ''}
              </dd>
            </dl>
            {artifact.data.kind === 'text' ? (
              <pre
                style={{
                  marginTop: 'var(--space-4)',
                  background: 'var(--color-code-bg)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-3)',
                  maxHeight: '60vh',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 'var(--font-size-sm)',
                }}
              >
                {artifact.data.text}
              </pre>
            ) : (
              <p style={{ marginTop: 'var(--space-4)', color: 'var(--color-text-muted)' }}>
                This artifact is binary. The API refused to render bytes inline; use a download flow when available.
              </p>
            )}
          </Panel>
        )}
      </div>
    </>
  )
}
