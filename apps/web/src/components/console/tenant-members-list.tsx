import { useQuery } from '@tanstack/react-query'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { Panel } from '~/components/primitives/panel.js'
import { queryKeys } from '~/lib/query-keys.js'

function formatJoined(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

/**
 * Members table for the Team tab. Shares the `tenantMembers` query key with
 * `<TenantOverviewCard />` so a single request hydrates both surfaces.
 */
export function TenantMembersList() {
  const { api } = useAppContext()
  const { me } = useAuth()
  const tenantId = me?.tenantId ?? ''

  const members = useQuery({
    enabled: Boolean(tenantId),
    queryKey: queryKeys.tenantMembers(tenantId),
    queryFn: () => api.tenant.members.query(),
    staleTime: 30_000,
  })

  const list = members.data?.members ?? []

  return (
    <Panel title="Members">
      {members.isLoading ? (
        <p className="console-muted" style={{ margin: 0 }}>
          Loading members…
        </p>
      ) : list.length === 0 ? (
        <EmptyState
          title="No members listed"
          description="Member listing requires API support or the tenant has no other members."
        />
      ) : (
        <div className="console-table-wrap">
          <table className="console-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {list.map((member) => (
                <tr key={member.id || member.email}>
                  <td>
                    {member.name ? (
                      <>
                        <span>{member.name}</span>
                        <span className="console-muted" style={{ marginLeft: 'var(--space-2)' }}>
                          {member.email}
                        </span>
                      </>
                    ) : (
                      member.email || '—'
                    )}
                  </td>
                  <td>{member.role}</td>
                  <td>{formatJoined(member.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
