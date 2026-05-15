import { QueryClient } from '@tanstack/react-query'
import { type RenderOptions, type RenderResult, render } from '@testing-library/react'
import type { ReactElement } from 'react'

import { AppProviders } from '~/app/providers.js'
import type { WebRuntimeConfig } from '~/lib/config.js'

const TEST_CONFIG: WebRuntimeConfig = {
  apiUrl: 'http://127.0.0.1:0',
  appEnv: 'development',
  marketingDocsUrl: null,
  githubUrl: null,
}

type WithProvidersOptions = RenderOptions & {
  skipAuth?: boolean
}

export function renderWithProviders(ui: ReactElement, options?: WithProvidersOptions): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const { skipAuth = true, ...renderOptions } = options ?? {}
  return render(
    <AppProviders config={TEST_CONFIG} queryClient={queryClient} skipAuth={skipAuth}>
      {ui}
    </AppProviders>,
    renderOptions,
  )
}
