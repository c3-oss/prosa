import { describe, expect, it } from 'vitest'

import { loadWebConfig } from './config.js'

function fakeEnv(overrides: Partial<ImportMetaEnv>): ImportMetaEnv {
  return {
    MODE: 'development',
    DEV: true,
    PROD: false,
    BASE_URL: '/',
    SSR: false,
    ...overrides,
  } as unknown as ImportMetaEnv
}

describe('loadWebConfig', () => {
  it('defaults to localhost dev API when env is development and url is empty', () => {
    const config = loadWebConfig(fakeEnv({ MODE: 'development' }))
    expect(config.apiUrl).toBe('http://localhost:3000')
    expect(config.appEnv).toBe('development')
  })

  it('requires VITE_PROSA_API_URL outside development', () => {
    expect(() => loadWebConfig(fakeEnv({ MODE: 'production', VITE_PROSA_APP_ENV: 'production' }))).toThrow(
      /VITE_PROSA_API_URL is required/,
    )
  })

  it('honors VITE_PROSA_API_URL and strips trailing slash', () => {
    const config = loadWebConfig(fakeEnv({ VITE_PROSA_API_URL: 'https://api.prosa.dev/' }))
    expect(config.apiUrl).toBe('https://api.prosa.dev')
  })
})
