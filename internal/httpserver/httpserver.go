// Package httpserver runs an *http.Server bound to a context, with a
// bounded graceful shutdown and a force-close fallback so CTRL+C
// always returns the prompt — even when long-lived handlers (SSE,
// streaming proxies) ignore request-context cancellation.
package httpserver

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Run blocks until ctx is cancelled or the server errors. On cancellation
// it attempts a graceful Shutdown bounded by graceTimeout; if that times
// out it calls srv.Close to force-terminate remaining connections.
func Run(ctx context.Context, srv *http.Server, graceTimeout time.Duration) error {
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), graceTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		_ = srv.Close()
		if errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return err
	}
	return nil
}
