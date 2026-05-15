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
