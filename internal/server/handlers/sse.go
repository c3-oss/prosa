// Package handlers ships a plain HTTP SSE endpoint /sse/events that
// forwards Postgres NOTIFY events on channel "prosa.session.changed".
// This lives outside Connect because Connect's streaming surface isn't
// SSE-friendly enough to justify the wrapper; raw HTTP + EventSource
// on the browser side is simpler.
package handlers

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SSEHandler streams session-changed events to authorized callers
// (panel). Callers prove authority with `Authorization: Admin <token>`
// — same scheme used by Connect's owner-mode interceptor.
type SSEHandler struct {
	Pool       *pgxpool.Pool
	AdminToken string
}

// NewSSEHandler wires the handler.
func NewSSEHandler(pool *pgxpool.Pool, adminToken string) *SSEHandler {
	return &SSEHandler{Pool: pool, AdminToken: adminToken}
}

// ServeHTTP implements the SSE protocol: keep the connection alive,
// pump events as `event: session.changed\ndata: <id>\n\n` chunks.
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	conn, err := h.Pool.Acquire(ctx)
	if err != nil {
		slog.Warn("sse: acquire conn failed", "err", err)
		return
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `LISTEN "prosa.session.changed"`); err != nil {
		slog.Warn("sse: LISTEN failed", "err", err)
		return
	}

	// Initial comment so the browser knows the stream is live.
	_, _ = fmt.Fprintln(w, ": connected")
	flusher.Flush()

	// Tick periodically so flaky proxies don't drop the connection.
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	events := make(chan string)
	errs := make(chan error, 1)
	go func() {
		for {
			n, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				errs <- err
				return
			}
			select {
			case events <- n.Payload:
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		select {
		case payload := <-events:
			_, _ = fmt.Fprintf(w, "event: session.changed\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-errs:
			return
		case <-heartbeat.C:
			_, _ = fmt.Fprintln(w, ": heartbeat")
			flusher.Flush()
		case <-ctx.Done():
			return
		}
	}
}

// authorized accepts callers with `Authorization: Admin <token>`
// matching the configured admin token.
func (h *SSEHandler) authorized(r *http.Request) bool {
	const prefix = "admin "
	auth := r.Header.Get("Authorization")
	if len(auth) <= len(prefix) {
		return false
	}
	if subtle.ConstantTimeCompare(
		[]byte(toLower(auth[:len(prefix)])), []byte(prefix),
	) != 1 {
		return false
	}
	tok := auth[len(prefix):]
	if h.AdminToken == "" {
		// Mirrors auth.Service.IsAdminToken: a request presented an Admin
		// token but the server has none configured. Log loudly so the
		// misconfiguration is diagnosable instead of a silent 401.
		slog.Error("sse: admin auth attempted but PROSA_ADMIN_TOKEN is not configured")
		return false
	}
	return subtle.ConstantTimeCompare([]byte(tok), []byte(h.AdminToken)) == 1
}

func toLower(s string) string {
	out := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}
