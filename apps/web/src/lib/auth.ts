import type { WebRuntimeConfig } from './config.js'

export type AuthMeUser = { id: string; email: string; name: string }

export type AuthSignInPayload = { email: string; password: string }

export type AuthSignUpPayload = {
  email: string
  password: string
  name: string
}

/**
 * Browser-side wrapper over the Better Auth HTTP endpoints mounted under
 * `/api/auth/*`. We deliberately keep this thin: the source of truth for the
 * session is the HTTP-only cookie set by Better Auth, and we never mirror
 * tokens, headers, or cookies into localStorage.
 */
export function createBrowserAuth(config: WebRuntimeConfig) {
  const base = `${config.apiUrl}/api/auth`
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `auth request failed: ${response.status}`)
    }
    if (response.status === 204) return null as T
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return null as T
    return (await response.json()) as T
  }

  return {
    signIn(payload: AuthSignInPayload): Promise<{ user: AuthMeUser } | null> {
      return post('/sign-in/email', payload)
    },
    signUp(payload: AuthSignUpPayload): Promise<{ user: AuthMeUser } | null> {
      return post('/sign-up/email', payload)
    },
    signOut(): Promise<null> {
      return post('/sign-out', {})
    },
  }
}

export type BrowserAuth = ReturnType<typeof createBrowserAuth>
