package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/sessionkind"
	"github.com/c3-oss/prosa/pkg/session"
)

// TestPushReconcilesOrchestratorKind covers issue #249: the server-side
// orchestrator tag must be pruned when a child loses or changes its parent,
// not just added. A re-parented or de-parented child should never leave a
// stale orchestrator classification on its former parent.
func TestPushReconcilesOrchestratorKind(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-orch"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	mux := http.NewServeMux()
	authSvc := auth.New(pool, adminToken, "http://panel.test")
	path, handler := prosav1connect.NewSessionsServiceHandler(
		NewSessionsHandler(pool, obj),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := prosav1connect.NewSessionsServiceClient(server.Client(), server.URL)

	hasOrch := func(id string) bool {
		req := connect.NewRequest(&prosav1.GetRequest{Id: id})
		req.Header().Set("Authorization", "Bearer "+bearer)
		resp, err := client.Get(ctx, req)
		require.NoError(t, err)
		return slices.Contains(resp.Msg.Session.Kinds, sessionkind.KindOrchestrator)
	}
	push := func(id, parent, body string) {
		pushKindSession(t, ctx, client, bearer, id, parent, body)
	}

	// Parent on its own is not an orchestrator; its first child makes it one.
	push("p1", "", "p1 v1")
	require.False(t, hasOrch("p1"))
	push("c1", "p1", "c1 v1")
	require.True(t, hasOrch("p1"))

	// De-parent the child (fresh raw so the push is not idempotency-skipped):
	// p1 has no children left and must be pruned.
	push("c1", "", "c1 v2")
	require.False(t, hasOrch("p1"))

	// Reassign the child to a new parent: the old parent stays clear and the
	// new parent gains the tag.
	push("p2", "", "p2 v1")
	push("c1", "p2", "c1 v3")
	require.False(t, hasOrch("p1"))
	require.True(t, hasOrch("p2"))
}

// pushKindSession pushes a one-turn session with the given id and optional
// parent. Each call should use a distinct body so the raw hash changes and
// the server does not short-circuit the push as already-synced.
func pushKindSession(t *testing.T, ctx context.Context, client prosav1connect.SessionsServiceClient, bearer, id, parent, body string) {
	t.Helper()
	raw := []byte(body)
	started := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	req := connect.NewRequest(&prosav1.PushRequest{
		Session: &prosav1.Session{
			Id:              id,
			Agent:           "codex",
			DeviceId:        "spoofed",
			ProjectPath:     "/work/prosa",
			StartedAt:       timestamppb.New(started),
			LastActivityAt:  timestamppb.New(started.Add(time.Minute)),
			RawHash:         sha256Hex(raw),
			RawSize:         int64(len(raw)),
			ParentSessionId: parent,
			Usage:           &prosav1.TokenUsage{TotalTokens: 10, InputTokens: 8, OutputTokens: 2},
		},
		Turns: []*prosav1.Turn{
			{Role: "user", Kind: session.KindMessage, Content: "hi", Ts: timestamppb.New(started)},
		},
		Raw: raw,
	})
	req.Header().Set("Authorization", "Bearer "+bearer)
	resp, err := client.Push(ctx, req)
	require.NoError(t, err)
	require.False(t, resp.Msg.Skipped)
}
