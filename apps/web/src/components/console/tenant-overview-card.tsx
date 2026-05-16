import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { Panel } from '~/components/primitives/panel.js'
import { queryKeys } from '~/lib/query-keys.js'

/**
 * Tenant overview side card: tenant id (copyable), role, and member count.
 * Shares its `members` query key with `<TenantMembersList />` so react-query
 * dedupes the network call across the two siblings on the Team tab.
 */
export function TenantOverviewCard() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? ''
  const [copied, setCopied] = useState(false)

  const members = useQuery({
    enabled: Boolean(tenantId),
    queryKey: queryKeys.tenantMembers(tenantId),
    queryFn: () => api.tenant.members.query(),
    staleTime: 30_000,
  })

  async function onCopy() {
    if (!tenantId) return
    try {
      await navigator.clipboard.writeText(tenantId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be denied in some browsers/contexts; silently ignore.
    }
  }

  return (
    <Panel title="Tenant overview">
      <dl className="console-defs">
        <div>
          <dt>Tenant ID</dt>
          <dd>
            <span className="console-mono">{tenantId || '—'}</span>
            {tenantId ? (
              <button type="button" className="console-copy-button" onClick={onCopy} aria-label="Copy tenant id">
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Your role</dt>
          <dd>{me?.memberRole ?? '—'}</dd>
        </div>
        <div>
          <dt>Members</dt>
          <dd>{members.data?.members.length ?? '…'}</dd>
        </div>
      </dl>
    </Panel>
  )
}
