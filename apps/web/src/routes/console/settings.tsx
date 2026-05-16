import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { TenantMembersList } from '~/components/console/tenant-members-list.js'
import { TenantOverviewCard } from '~/components/console/tenant-overview-card.js'
import { Button } from '~/components/primitives/button.js'
import { EmptyState } from '~/components/primitives/empty-state.js'
import { Panel } from '~/components/primitives/panel.js'
import { TextField } from '~/components/primitives/text-field.js'
import { ThemeToggleRadioGroup } from '~/components/primitives/theme-toggle.js'

const TABS = [
  { value: 'team', label: 'Team' },
  { value: 'account', label: 'Account' },
  { value: 'preferences', label: 'Preferences' },
] as const

type SettingsSection = (typeof TABS)[number]['value']

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
    <div className="console-settings-grid">
      <Panel title="Invite teammate">
        {isAdmin ? (
          <form onSubmit={onSubmit} className="console-stack">
            <TextField
              label="Invite by email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div className="console-form-row">
              <label className="console-field">
                <span className="console-field-label">Role</span>
                <select
                  className="console-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </label>
              <Button type="submit" variant="primary" disabled={invite.isPending}>
                {invite.isPending ? 'Sending…' : 'Send invite'}
              </Button>
            </div>
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
          </form>
        ) : (
          <EmptyState
            title="Read-only role"
            description="Members can view team membership but cannot invite users or change roles."
          />
        )}
      </Panel>
      <TenantOverviewCard />
      <div className="console-settings-fullspan">
        <TenantMembersList />
      </div>
    </div>
  )
}

function AccountSettings() {
  const { me } = useAuth()
  return (
    <div className="console-settings-grid">
      <Panel title="Profile">
        <dl className="console-defs">
          <div>
            <dt>User</dt>
            <dd>{me?.user.name ?? '—'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{me?.user.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Active tenant</dt>
            <dd className="console-mono">{me?.tenantId ?? '—'}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{me?.memberRole ?? '—'}</dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Session">
        <p className="console-muted" style={{ margin: 0 }}>
          You are signed in. To rotate your session, use the sign-out action in the sidebar.
        </p>
      </Panel>
    </div>
  )
}

function PreferencesSettings() {
  return (
    <div className="console-settings-grid">
      <Panel title="Appearance">
        <ThemeToggleRadioGroup />
        <p className="console-muted" style={{ marginTop: 'var(--space-3)' }}>
          System follows your OS preference.
        </p>
      </Panel>
    </div>
  )
}

export function ConsoleSettings() {
  const { section: raw } = useParams({ strict: false }) as { section?: string }
  const section: SettingsSection = TABS.some((t) => t.value === raw) ? (raw as SettingsSection) : 'team'

  return (
    <>
      <header className="console-page-header">
        <div>
          <h1>Settings</h1>
          <p>Tenant members, invites, roles, account and appearance.</p>
        </div>
      </header>
      <div className="console-content">
        <nav aria-label="Settings sections" className="console-segmented">
          {TABS.map((tab) => (
            <Link
              key={tab.value}
              to="/console/settings/$section"
              params={{ section: tab.value }}
              aria-pressed={section === tab.value}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        {section === 'team' ? <TeamSettings /> : section === 'account' ? <AccountSettings /> : <PreferencesSettings />}
      </div>
    </>
  )
}
