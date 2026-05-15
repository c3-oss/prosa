import { describe, expect, it } from 'vitest'
import { buildTestApp } from './helpers/test-app.js'

async function trpc(appT: Awaited<ReturnType<typeof buildTestApp>>, path: string, input: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return appT.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers,
    payload: input as never,
  })
}

describe('CLI device authorization flow', () => {
  it('issues a device code, signals pending while not approved, returns token after approval', async () => {
    const t = await buildTestApp()
    try {
      // 1. Sign up a user — this is the user that will "approve" the device.
      const signupResp = await trpc(t, 'auth.signupWithTenant', {
        email: 'dev-flow@example.com',
        password: 'correct-horse-battery',
        name: 'Device User',
        tenantName: 'DevCorp',
        tenantSlug: 'devcorp',
      })
      expect(signupResp.statusCode).toBe(200)
      const userToken = (signupResp.json() as { result: { data: { token: string } } }).result.data.token

      // 2. Request a device code.
      const codeResp = await trpc(t, 'auth.deviceCode', { clientId: 'prosa-cli' })
      expect(codeResp.statusCode).toBe(200)
      const code = (
        codeResp.json() as {
          result: {
            data: {
              deviceCode: string
              userCode: string
              verificationUri: string
              expiresIn: number
              interval: number
            }
          }
        }
      ).result.data
      expect(code.deviceCode).toBeTruthy()
      expect(code.userCode).toBeTruthy()
      expect(code.verificationUri).toContain('/device')

      // 3. Poll once before approval — should return pending=true.
      const pendingResp = await trpc(t, 'auth.deviceToken', {
        deviceCode: code.deviceCode,
        clientId: 'prosa-cli',
      })
      expect(pendingResp.statusCode).toBe(200)
      const pendingBody = pendingResp.json() as { result: { data: { pending: boolean } } }
      expect(pendingBody.result.data.pending).toBe(true)

      // 4. Approve the device by updating the device_code row directly.
      //    In real life the browser visits the verification URI, signs in,
      //    and approves. Here we simulate by marking the row as approved
      //    and attaching the existing user.
      const userRow = await t.pglite.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1 LIMIT 1`, [
        'dev-flow@example.com',
      ])
      const userId = userRow.rows[0]?.id
      expect(userId).toBeTruthy()
      await t.pglite.query(
        `UPDATE "device_code"
            SET status = 'approved', user_id = $1, last_polled_at = NULL
          WHERE device_code = $2`,
        [userId, code.deviceCode],
      )
      // Default plugin interval is 5s; clear lastPolledAt so the next poll
      // is not rejected as "slow_down".
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      // 5. Poll again — should return token.
      const tokenResp = await trpc(t, 'auth.deviceToken', {
        deviceCode: code.deviceCode,
        clientId: 'prosa-cli',
      })
      expect(tokenResp.statusCode).toBe(200)
      const tokenBody = tokenResp.json() as {
        result: { data: { pending: boolean; token?: string; user?: { email: string } } }
      }
      expect(tokenBody.result.data.pending).toBe(false)
      expect(tokenBody.result.data.token).toBeTruthy()

      // 6. Use the returned token to call auth.me successfully.
      const meResp = await t.app.inject({
        method: 'GET',
        url: '/trpc/auth.me',
        headers: { authorization: `Bearer ${tokenBody.result.data.token}` },
      })
      expect(meResp.statusCode).toBe(200)
      const meBody = meResp.json() as { result: { data: { user: { email: string } | null } } }
      expect(meBody.result.data.user?.email).toBe('dev-flow@example.com')

      // 7. The pre-signup user token also still works.
      const oldMeResp = await t.app.inject({
        method: 'GET',
        url: '/trpc/auth.me',
        headers: { authorization: `Bearer ${userToken}` },
      })
      expect(oldMeResp.statusCode).toBe(200)
    } finally {
      await t.close()
    }
  })
})

describe('CQ-011 — device-token flow must reject / strip tokens for browser-origin callers', () => {
  async function approveDeviceCode(t: Awaited<ReturnType<typeof buildTestApp>>, email: string) {
    const signupResp = await trpc(t, 'auth.signupWithTenant', {
      email,
      password: 'correct-horse-battery',
      name: 'CQ-011 user',
      tenantName: 'CQ011',
      tenantSlug: email.replaceAll(/[^a-z0-9]/g, '-'),
    })
    expect(signupResp.statusCode).toBe(200)
    const codeResp = await trpc(t, 'auth.deviceCode', { clientId: 'prosa-cli' })
    expect(codeResp.statusCode).toBe(200)
    const deviceCode = (codeResp.json() as { result: { data: { deviceCode: string } } }).result.data.deviceCode
    const userRow = await t.pglite.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1 LIMIT 1`, [email])
    const userId = userRow.rows[0]?.id
    expect(userId).toBeTruthy()
    await t.pglite.query(
      `UPDATE "device_code" SET status='approved', user_id=$1, last_polled_at=NULL WHERE device_code=$2`,
      [userId, deviceCode],
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    return deviceCode
  }

  it('rejects tRPC auth.deviceToken when Origin equals the API URL (same-origin browser deploy)', async () => {
    const t = await buildTestApp()
    try {
      const deviceCode = await approveDeviceCode(t, 'cq011-trpc-same@example.com')
      const resp = await t.app.inject({
        method: 'POST',
        url: '/trpc/auth.deviceToken',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        payload: { deviceCode, clientId: 'prosa-cli' } as never,
      })
      // FORBIDDEN translates to HTTP 403 via tRPC.
      expect(resp.statusCode).toBe(403)
      // No token-bearing fields anywhere in the body.
      expect(resp.body).not.toContain('access_token')
      expect(resp.body.match(/"token"/)).toBeNull()
    } finally {
      await t.close()
    }
  })

  it('rejects tRPC auth.deviceToken when Origin is a configured web origin', async () => {
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: 'https://app.example.com' })
    try {
      const deviceCode = await approveDeviceCode(t, 'cq011-trpc-web@example.com')
      const resp = await t.app.inject({
        method: 'POST',
        url: '/trpc/auth.deviceToken',
        headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
        payload: { deviceCode, clientId: 'prosa-cli' } as never,
      })
      expect(resp.statusCode).toBe(403)
      expect(resp.body).not.toContain('access_token')
      expect(resp.body.match(/"token"/)).toBeNull()
    } finally {
      await t.close()
    }
  })

  it('strips bearer-token-bearing fields from raw /api/auth/device/token for browser-origin callers', async () => {
    const t = await buildTestApp()
    try {
      const deviceCode = await approveDeviceCode(t, 'cq011-raw@example.com')
      const resp = await t.app.inject({
        method: 'POST',
        url: '/api/auth/device/token',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        payload: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: 'prosa-cli',
        } as never,
      })
      // Status may be 200 (approved) or carry an error; either way, the body
      // must not contain any bearer-token-bearing field for a browser-origin
      // caller.
      expect(resp.statusCode).toBeGreaterThanOrEqual(200)
      const body = resp.body
      expect(body).not.toMatch(/"access_token"\s*:/)
      expect(body).not.toMatch(/"accessToken"\s*:/)
      expect(body).not.toMatch(/"refresh_token"\s*:/)
      expect(body).not.toMatch(/"refreshToken"\s*:/)
      expect(body).not.toMatch(/"id_token"\s*:/)
      // A bare `"token":` (Better Auth session shape) must also be absent.
      expect(body).not.toMatch(/"token"\s*:/)
    } finally {
      await t.close()
    }
  })

  it('keeps the no-Origin CLI/device flow returning a token after approval', async () => {
    const t = await buildTestApp()
    try {
      const deviceCode = await approveDeviceCode(t, 'cq011-cli@example.com')
      const resp = await t.app.inject({
        method: 'POST',
        url: '/trpc/auth.deviceToken',
        headers: { 'content-type': 'application/json' }, // no Origin
        payload: { deviceCode, clientId: 'prosa-cli' } as never,
      })
      expect(resp.statusCode).toBe(200)
      const body = resp.json() as { result: { data: { pending: boolean; token?: string } } }
      expect(body.result.data.pending).toBe(false)
      expect(body.result.data.token).toBeTruthy()
    } finally {
      await t.close()
    }
  })
})
