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
      // Invalidate everything tenant-scoped: auth.me to pick up the new active
      // tenant and any tenant-prefixed query keys.
      await queryClient.invalidateQueries()
      await refresh()
    },
  })

  if (!me) return null

  return (
    <div className="console-sidebar-section">
      <span>Tenant</span>
      <select
        aria-label="Active tenant"
        value={me.tenantId ?? ''}
        disabled={setActive.isPending || me.tenants.length <= 1}
        onChange={(event) => {
          const next = event.target.value
          if (!next || next === me.tenantId) return
          setActive.mutate(next)
        }}
        style={{
          background: 'var(--color-bg-elevated)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '6px 8px',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-sm)',
        }}
      >
        {me.tenants.length === 0 ? <option value="">No tenants</option> : null}
        {me.tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
            {tenant.slug ? ` (${tenant.slug})` : ''}
          </option>
        ))}
      </select>
      {me.memberRole ? (
        <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-xs)' }}>role: {me.memberRole}</span>
      ) : null}
    </div>
  )
}
