import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { TextField } from '~/components/primitives/text-field.js'

export function SignupPage() {
  const { api, setTenantId } = useAppContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenantName, setTenantName] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')

  const signup = useMutation({
    mutationFn: async (payload: {
      email: string
      password: string
      name: string
      tenantName: string
      tenantSlug?: string
    }) => {
      return api.auth.signupWithTenant.mutate(payload)
    },
    onSuccess: async () => {
      setTenantId(null)
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      await queryClient.refetchQueries({ queryKey: ['auth', 'me'], type: 'active' })
      navigate({ to: '/console' })
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    signup.mutate({
      email,
      password,
      name,
      tenantName,
      ...(tenantSlug ? { tenantSlug } : {}),
    })
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
      {signup.error ? (
        <p role="alert" style={{ color: 'var(--color-danger)', margin: 0, fontSize: 'var(--font-size-sm)' }}>
          {signup.error instanceof Error ? signup.error.message : 'Signup failed'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={signup.isPending}>
        {signup.isPending ? 'Creating…' : 'Create account'}
      </Button>
      <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </form>
  )
}
