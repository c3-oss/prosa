import { Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { TextField } from '~/components/primitives/text-field.js'

export function LoginPage() {
  const { auth } = useAppContext()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await auth.signIn({ email, password })
      window.location.assign('/console')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-labelledby="login-heading"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <h1 id="login-heading" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--font-size-xl)', margin: 0 }}>
        Sign in
      </h1>
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
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error ? (
        <p role="alert" style={{ color: 'var(--color-danger)', margin: 0, fontSize: 'var(--font-size-sm)' }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
        No account? <Link to="/signup">Create one</Link>
      </p>
    </form>
  )
}
