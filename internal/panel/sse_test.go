package panel

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// signalWriter closes wrote on the first Write so the test can tell when
// the proxy has entered its read loop (i.e. Do() returned and the stream
// is flowing), making the disconnect assertion deterministic.
type signalWriter struct {
	http.ResponseWriter
	wrote chan struct{}
	once  sync.Once
}

func (s *signalWriter) Write(b []byte) (int, error) {
	s.once.Do(func() { close(s.wrote) })
	return s.ResponseWriter.Write(b)
}

func (s *signalWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// The SSE proxy must not leak its goroutine when the browser disconnects:
// closing the upstream body on r.Context().Done() unblocks the read loop
// even while the upstream is still holding the stream open with no further
// data. See issue #94.
func TestHandleSSEExitsOnClientDisconnect(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f, _ := w.(http.Flusher)
		// Send one heartbeat so the proxy enters its read loop, then hold
		// the stream open with no further data until the proxy goes away.
		_, _ = w.Write([]byte(": connected\n\n"))
		if f != nil {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	t.Cleanup(upstream.Close)

	p, err := New(Config{
		ServerURL:     upstream.URL,
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"dev@localhost"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
	sw := &signalWriter{ResponseWriter: httptest.NewRecorder(), wrote: make(chan struct{})}

	done := make(chan struct{})
	go func() {
		p.handleSSE(sw, req)
		close(done)
	}()

	select {
	case <-sw.wrote:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy never forwarded upstream data (never reached read loop)")
	}

	cancel() // browser disconnects mid-stream

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handleSSE did not return after client disconnect")
	}
}
