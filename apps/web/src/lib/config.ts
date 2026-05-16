export type WebRuntimeConfig = {
  apiUrl: string
  appEnv: 'development' | 'preview' | 'production'
  marketingDocsUrl: string | null
  githubUrl: string | null
}

const DEFAULT_DEV_API_URL = 'http://localhost:3000'

function readEnv(): ImportMetaEnv {
  return import.meta.env
}

export function loadWebConfig(env: ImportMetaEnv = readEnv()): WebRuntimeConfig {
  const appEnv = env.VITE_PROSA_APP_ENV ?? (env.MODE === 'production' ? 'production' : 'development')
  const apiUrl = env.VITE_PROSA_API_URL?.trim() || (appEnv === 'development' ? DEFAULT_DEV_API_URL : '')
  if (!apiUrl) {
    throw new Error(
      'VITE_PROSA_API_URL is required when VITE_PROSA_APP_ENV is not "development". Refusing to start with an undefined API origin.',
    )
  }
  return {
    apiUrl: apiUrl.replace(/\/$/, ''),
    appEnv,
    marketingDocsUrl: env.VITE_PROSA_MARKETING_DOCS_URL?.trim() || null,
    githubUrl: env.VITE_PROSA_GITHUB_URL?.trim() || null,
  }
}
