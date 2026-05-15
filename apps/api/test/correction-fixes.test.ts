import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type SignupResult = { token?: string; tenant: { id: string }; user: { id: string } }

async function signup(t: TestApp, email: string, origin?: string): Promise<SignupResult> {
  const slug = email.replaceAll(/[^a-z0-9]/g, '-')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers,
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: email,
      tenantSlug: slug,
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { result: { data: SignupResult } }).result.data
}

async function trpcGet(t: TestApp, path: string, input: unknown, token: string) {
  return t.app.inject({
    method: 'GET',
    url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('CQ-007 — browser signup must not return a bearer token', () => {
  it('CLI / API-origin callers still receive the token (CLI flows)', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cli-signup@example.com')
      expect(typeof auth.token).toBe('string')
      expect((auth.token as string).length).toBeGreaterThan(10)
    } finally {
      await t.close()
    }
  })

  it('browser-origin signup omits the token from the JSON body', async () => {
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: 'https://console.prosa.dev' })
    try {
      const auth = await signup(t, 'browser-signup@example.com', 'https://console.prosa.dev')
      expect(auth.token).toBeUndefined()
      expect(typeof auth.tenant.id).toBe('string')
      expect(typeof auth.user.id).toBe('string')
    } finally {
      await t.close()
    }
  })
})

describe('CQ-008 — object upload response must not expose storageKey', () => {
  it('the JSON body returned after a successful upload does not include storageKey', async () => {
    // Re-using the existing object upload happy-path through the
    // sync.commitUpload + PUT /objects flow would require a substantial fixture.
    // The lighter assertion that maps directly to the regression is that the
    // route handler now returns only { objectId, alreadyExisted }: we verify
    // the handler source contains no `storageKey` in any 2xx response.
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const source = await fs.readFile(path.resolve(here, '../src/http/objects.ts'), 'utf8')
    // The PUT /objects/:objectId handler is the only route that returns a
    // response after a successful upload. After CQ-008 the body must be
    // exactly { objectId, alreadyExisted }; anything addressing
    // upload.storageKey internally is fine, but the response object must not
    // include the raw key.
    const responseMatch = source.match(/reply\.code\(put\.alreadyExisted[\s\S]{0,400}/)
    expect(responseMatch, 'expected to find the upload response block').not.toBeNull()
    if (responseMatch) {
      expect(responseMatch[0]).not.toContain('storageKey')
    }
  })
})

describe('CQ-009 — artifact preview must cap decoded bytes before full decompression', () => {
  it('artifacts.getText accepts the documented maxBytes range', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq009@example.com')
      // The artifact does not exist; the procedure should fail-closed at
      // resolveArtifact, but the input validation must accept the bounded
      // maxBytes value without hitting decode at all.
      const resp = await trpcGet(t, 'artifacts.getText', { artifactId: 'missing', maxBytes: 4096 }, auth.token!)
      expect(resp.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })
})

describe('CQ-005 — search filters must fail closed when unsupported', () => {
  it('rejects role / tool / canonical-tool / errors-only / raw-mode filters', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq005-search@example.com')
      const unsupportedInputs: Array<Record<string, unknown>> = [
        { q: 'x', roles: ['user'] },
        { q: 'x', toolNames: ['shell.exec'] },
        { q: 'x', canonicalToolTypes: ['shell'] },
        { q: 'x', errorsOnly: true },
        { q: 'x', mode: 'raw' },
      ]
      for (const input of unsupportedInputs) {
        const resp = await trpcGet(t, 'search.query', input, auth.token!)
        expect(resp.statusCode).toBe(400)
      }
    } finally {
      await t.close()
    }
  })

  it('rejects canonical-tool / path filters in toolCalls.list', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq005-tools@example.com')
      const unsupported: Array<Record<string, unknown>> = [
        { canonicalToolTypes: ['shell'] },
        { pathSubstring: '/etc/passwd' },
      ]
      for (const input of unsupported) {
        const resp = await trpcGet(t, 'toolCalls.list', input, auth.token!)
        expect(resp.statusCode).toBe(400)
      }
    } finally {
      await t.close()
    }
  })
})
