import process from 'node:process'

/**
 * Boots `apps/api` in-process against a PGlite database and the memory
 * object store, then signs up a seed tenant + verified session so the
 * browser E2E (CQ-001) has authenticated data to render.
 *
 * Launched by Playwright's `webServer` config. Listens on
 * `PROSA_API_PORT` (default 3001).
 */

async function bootApiServer() {
  const { applySchema } = await import('@c3-oss/prosa-db')
  const { MemoryObjectStore } = await import('@c3-oss/prosa-storage')
  const { PGlite } = await import('@electric-sql/pglite')
  const { buildApp, createAuth, loadConfig, openPgliteDatabase } = await import('@c3-oss/prosa-api')

  const port = Number.parseInt(process.env.PROSA_API_PORT ?? '3001', 10)
  const webOrigin = process.env.PROSA_WEB_ORIGIN ?? `http://127.0.0.1:${process.env.PROSA_WEB_E2E_PORT ?? '5174'}`

  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 'memory',
    PROSA_AUTH_SECRET: 'e2e-secret-1234567890abcdef',
    PROSA_API_URL: `http://127.0.0.1:${port}`,
    PROSA_API_PORT: String(port),
    PROSA_WEB_ORIGIN: webOrigin,
    PROSA_LOG_LEVEL: 'warn',
  } as NodeJS.ProcessEnv)

  const pglite = new PGlite()
  await applySchema(pglite)
  const db = openPgliteDatabase(pglite)
  const auth = createAuth({ config, db: db.db })
  const objectStore = new MemoryObjectStore()

  const app = await buildApp({
    config,
    auth,
    db: db.db,
    rawExec: db.rawExec,
    transaction: db.transaction,
    objectStore,
    loggerEnabled: false,
  })

  await app.listen({ host: '127.0.0.1', port })
  process.stdout.write(`prosa-api e2e listening on http://127.0.0.1:${port} (web origin ${webOrigin})\n`)

  const shutdown = async () => {
    try {
      await app.close()
    } catch {}
    try {
      await pglite.close()
    } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

bootApiServer().catch((err) => {
  process.stderr.write(
    `prosa-api e2e failed to boot: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
