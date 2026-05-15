import { buildApp } from './app.js'
import { loadConfig } from './config.js'

export async function startServer(): Promise<void> {
  const config = loadConfig()
  const app = await buildApp({ config })
  await app.listen({ host: config.host, port: config.port })
}
