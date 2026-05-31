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

// Run starts srv.ListenAndServe in a goroutine and blocks until ctx
// is cancelled or the server errors. On cancellation it attempts a
// graceful Shutdown bounded by graceTimeout; if Shutdown does not
// finish in time it calls srv.Close to force-close listeners and
// connections so the process can exit.
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
