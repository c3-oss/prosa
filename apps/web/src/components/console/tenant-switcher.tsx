import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'

export function TenantSwitcher() {
  const { api, setTenantId } = useAppContext()
  const { me, refresh } = useAuth()
  const queryClient = useQueryClient()

  const setActive = useMutation({
    mutationFn: async (tenantId: string) => {
      await api.tenant.setActive.mutate({ tenantId })
      return tenantId
    },
    onSuccess: async (tenantId) => {
      setTenantId(tenantId)
      await queryClient.invalidateQueries()
      await refresh()
    },
  })

  if (!me) return null

  return (
    <div className="console-sidebar-section">
      <span className="console-sidebar-label">Tenant</span>
      <select
        className="console-select"
        aria-label="Active tenant"
        value={me.tenantId ?? ''}
        disabled={setActive.isPending || me.tenants.length <= 1}
        onChange={(event) => {
          const next = event.target.value
          if (!next || next === me.tenantId) return
          setActive.mutate(next)
        }}
      >
        {me.tenants.length === 0 ? <option value="">No tenants</option> : null}
        {!me.tenantId && me.tenants.length > 0 ? <option value="">Pick a tenant</option> : null}
        {me.tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
            {tenant.slug ? ` (${tenant.slug})` : ''}
          </option>
        ))}
      </select>
      {me.memberRole ? <span className="console-faint">role: {me.memberRole}</span> : null}
    </div>
  )
}
