import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { loadConfig } from './config.js'
import { openPostgresDatabase } from './db.js'

export async function startServer(): Promise<void> {
  const config = loadConfig()
  if (!config.databaseUrl) {
    throw new Error('PROSA_DATABASE_URL is required to start the server')
  }
  const dbHandle = await openPostgresDatabase(config.databaseUrl)
  const auth = createAuth({ config, db: dbHandle.db })
  const app = await buildApp({ config, auth })
  await app.listen({ host: config.host, port: config.port })
}
