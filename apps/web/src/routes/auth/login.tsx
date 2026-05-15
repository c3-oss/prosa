import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useAppContext } from '~/app/providers.js'
import { Button } from '~/components/primitives/button.js'
import { TextField } from '~/components/primitives/text-field.js'

export function LoginPage() {
  const { auth } = useAppContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const signIn = useMutation({
    mutationFn: async (payload: { email: string; password: string }) => auth.signIn(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      navigate({ to: '/console' })
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    signIn.mutate({ email, password })
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
      {signIn.error ? (
        <p role="alert" style={{ color: 'var(--color-danger)', margin: 0, fontSize: 'var(--font-size-sm)' }}>
          {signIn.error instanceof Error ? signIn.error.message : 'Sign-in failed'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={signIn.isPending}>
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
        No account? <Link to="/signup">Create one</Link>
      </p>
    </form>
  )
}
