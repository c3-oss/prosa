package panel

import (
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// handleSSE proxies the server's /sse/events stream to the browser.
// The panel adds the Admin header so the server lets it in; the
// sseProxyClient proxies the upstream /sse/events stream. ResponseHeaderTimeout
// bounds only the wait for the upstream's response headers, so a stuck
// upstream can't hang the proxy goroutine at dial time; the body stream
// itself stays unbounded (no client Timeout) so long-lived SSE isn't cut.
// Cloned from DefaultTransport to keep its connection-pool defaults.
var sseProxyClient = &http.Client{
	Transport: func() http.RoundTripper {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = 10 * time.Second
		return t
	}(),
}

// browser only ever sees a normal SSE stream from the same origin
// (no CORS / cross-site cookie issues).
func (p *Panel) handleSSE(w http.ResponseWriter, r *http.Request) {
	upstream := strings.TrimRight(p.cfg.ServerURL, "/") + "/sse/events"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Admin "+p.cfg.AdminToken)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := sseProxyClient.Do(req)
	if err != nil {
		slog.Warn("sse upstream dial failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "upstream sse error: "+resp.Status, http.StatusBadGateway)
		return
	}

	// Close the upstream body as soon as the browser disconnects so the
	// read loop below unblocks promptly instead of waiting for the upstream
	// to send data or EOF. The watcher always returns: when this handler
	// finishes, net/http cancels r.Context(). Closing twice (here + defer)
	// is harmless.
	go func() {
		<-r.Context().Done()
		_ = resp.Body.Close()
	}()

	// Set our own SSE headers rather than forwarding the upstream's, and
	// keep them aligned with the server SSE handler (internal/server/handlers
	// sse.go): no-cache + private and X-Accel-Buffering: no, so the
	// anti-buffering/anti-cache behavior holds regardless of which front the
	// panel sits behind.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, private")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}
