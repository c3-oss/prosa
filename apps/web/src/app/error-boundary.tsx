import { Component, type ErrorInfo, type ReactNode } from 'react'

type State = { error: Error | null }

export class WebErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Surface the error to the console — production builds can hook this
    // into an external reporter once a privacy-reviewed pipeline exists.
    // We never log auth headers, cookies, or PII here.
    // biome-ignore lint/suspicious/noConsole: this is the global frontend error sink.
    console.error('prosa-web error boundary', error, info.componentStack)
  }

  reset = (): void => this.setState({ error: null })

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          background: 'var(--color-bg)',
          color: 'var(--color-text)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-8)',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontFamily: 'var(--font-display)' }}>Something went wrong</h1>
          <p style={{ color: 'var(--color-text-muted)' }}>
            The console hit an unexpected error. Reload to try again. If this keeps happening, capture the message below
            for support.
          </p>
          <pre
            style={{
              textAlign: 'left',
              background: 'var(--color-code-bg)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--space-3)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-size-sm)',
              overflow: 'auto',
              maxHeight: 240,
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            style={{
              marginTop: 'var(--space-4)',
              background: 'var(--color-accent)',
              color: '#04150b',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 16px',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
}
