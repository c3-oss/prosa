import { Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { TextField } from '~/components/primitives/text-field.js'

export function SignupPage() {
  const { api } = useAppContext()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenantName, setTenantName] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.auth.signupWithTenant.mutate({
        email,
        password,
        name,
        tenantName,
        ...(tenantSlug ? { tenantSlug } : {}),
      })
      window.location.assign('/console')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-labelledby="signup-heading"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <h1 id="signup-heading" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--font-size-xl)', margin: 0 }}>
        Create your account
      </h1>
      <TextField label="Name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        description="At least 8 characters."
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <TextField label="Tenant name" required value={tenantName} onChange={(e) => setTenantName(e.target.value)} />
      <TextField
        label="Tenant slug"
        description="Optional, lowercase letters, numbers, hyphens."
        value={tenantSlug}
        onChange={(e) => setTenantSlug(e.target.value)}
      />
      {error ? (
        <p role="alert" style={{ color: 'var(--color-danger)', margin: 0, fontSize: 'var(--font-size-sm)' }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </Button>
      <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </form>
  )
}
