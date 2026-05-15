import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { Panel } from '~/components/primitives/panel.js'
import { TextField } from '~/components/primitives/text-field.js'

function TeamSettings() {
  const { api } = useAppContext()
  const { me, refresh } = useAuth()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')

  const isAdmin = me?.memberRole === 'admin' || me?.memberRole === 'owner'

  const invite = useMutation({
    mutationFn: async (payload: { email: string; role: 'admin' | 'member' }) => {
      return api.tenant.invite.mutate(payload)
    },
    onSuccess: async () => {
      setEmail('')
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      await refresh()
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    invite.mutate({ email, role })
  }

  return (
    <Panel title="Team members">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div>
          <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
            Tenant: <strong style={{ color: 'var(--color-text)' }}>{me?.tenantId ?? '—'}</strong> · Your role:{' '}
            <strong style={{ color: 'var(--color-text)' }}>{me?.memberRole ?? 'unknown'}</strong>
          </p>
        </div>
        {isAdmin ? (
          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <TextField
              label="Invite by email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
                style={{
                  background: 'var(--color-bg-elevated)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px 12px',
                }}
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            {invite.error ? (
              <p role="alert" style={{ color: 'var(--color-danger)', margin: 0, fontSize: 'var(--font-size-sm)' }}>
                {invite.error instanceof Error ? invite.error.message : 'Invite failed'}
              </p>
            ) : null}
            {invite.isSuccess ? (
              <p style={{ color: 'var(--color-accent)', margin: 0, fontSize: 'var(--font-size-sm)' }}>
                Invitation sent. The invitee will receive an email when the API is configured for email delivery.
              </p>
            ) : null}
            <Button type="submit" variant="primary" disabled={invite.isPending}>
              {invite.isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </form>
        ) : (
          <EmptyState
            title="Read-only role"
            description="Members can view team membership but cannot invite users or change roles. Ask an admin or owner to invite teammates."
          />
        )}
      </div>
    </Panel>
  )
}

function AccountSettings() {
  const { me } = useAuth()
  return (
    <Panel title="Account">
      <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', color: 'var(--color-text-muted)' }}>
        <li>User: {me?.user.name}</li>
        <li>Email: {me?.user.email}</li>
        <li>Active tenant: {me?.tenantId ?? '—'}</li>
        <li>Role in active tenant: {me?.memberRole ?? '—'}</li>
      </ul>
    </Panel>
  )
}

export function ConsoleSettings() {
  const { section } = useParams({ strict: false }) as { section?: string }
  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Settings · {section ?? 'team'}</h1>
          <p>Tenant members, invites, roles, and account.</p>
        </div>
      </header>
      <div className="console-content">{section === 'account' ? <AccountSettings /> : <TeamSettings />}</div>
    </>
  )
}
