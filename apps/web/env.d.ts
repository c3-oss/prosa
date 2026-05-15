/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROSA_API_URL?: string
  readonly VITE_PROSA_APP_ENV?: 'development' | 'preview' | 'production'
  readonly VITE_PROSA_MARKETING_DOCS_URL?: string
  readonly VITE_PROSA_GITHUB_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
