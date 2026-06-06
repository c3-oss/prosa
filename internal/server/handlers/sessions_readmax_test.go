package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// connect.WithReadMaxBytes (wired in server.New for every handler) must
// reject an over-limit request before it is decoded into memory, so a
// multi-GB PushRequest.raw can't exhaust RAM/S3. We mirror that wiring with
// a small 1 MiB limit and push 2 MiB to keep the test fast. See issue #131.
func TestSessionsPushRejectsOversizedRequest(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		bearer   = "device-bearer"
		deviceID = "device-a"
		limit    = 1 << 20 // 1 MiB
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	mux := http.NewServeMux()
	authSvc := auth.New(pool, "admin-token", "http://panel.test")
	path, handler := prosav1connect.NewSessionsServiceHandler(
		NewSessionsHandler(pool, obj),
		connect.WithReadMaxBytes(limit),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := prosav1connect.NewSessionsServiceClient(server.Client(), server.URL)
	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)

	big := bytes.Repeat([]byte("x"), 2<<20) // 2 MiB > limit
	req := connect.NewRequest(&prosav1.PushRequest{
		Session: &prosav1.Session{
			Id:             "session-big",
			Agent:          "codex",
			StartedAt:      timestamppb.New(started),
			LastActivityAt: timestamppb.New(started),
			RawHash:        "hash-big",
			RawSize:        int64(len(big)),
		},
		Raw: big,
	})
	req.Header().Set("Authorization", "Bearer "+bearer)

	_, err := client.Push(ctx, req)
	require.Error(t, err)
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
}
