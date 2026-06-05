package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/server/storage"
)

// When a metadata write fails, the raw object uploaded earlier in Push must
// not be left orphaned in the bucket. We force the tx to fail by dropping
// the turns table so replaceTurns errors after upsertSession has run, then
// assert the just-uploaded object was cleaned up and the session row was
// rolled back. See issue #87.
func TestSessionsPushCleansUpRawOnMetadataFailure(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj, fake := newTestObjectStoreWithFake(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		sessionID  = "session-cleanup"
		agent      = "codex"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	// Force replaceTurns to fail mid-tx.
	_, err := pool.Exec(ctx, `DROP TABLE turns CASCADE`)
	require.NoError(t, err)

	client := newPushClient(t, pool, obj, adminToken)
	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	key := rawKey(deviceID, agent, sessionID, started.UTC())

	pushReq := connect.NewRequest(&prosav1.PushRequest{
		Session: &prosav1.Session{
			Id:             sessionID,
			Agent:          agent,
			StartedAt:      timestamppb.New(started),
			LastActivityAt: timestamppb.New(started),
			RawHash:        "hash-cleanup",
			RawSize:        3,
		},
		Raw:   []byte("raw"),
		Turns: []*prosav1.Turn{{Role: "user", Content: "hi", Ts: timestamppb.New(started)}},
	})
	pushReq.Header().Set("Authorization", "Bearer "+bearer)

	_, err = client.Push(ctx, pushReq)
	require.Error(t, err)
	require.Equal(t, connect.CodeInternal, connect.CodeOf(err))

	// Object was uploaded then removed on the rollback path: no orphan.
	_, found := fake.object(key)
	require.False(t, found, "orphaned raw object was not cleaned up")

	// Metadata was rolled back: no session row leaked.
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = $1`, sessionID).Scan(&count))
	require.Zero(t, count)
}

// A re-push that overwrites an already-stored object must not delete it when
// the metadata tx fails: the pre-existing object is still referenced by the
// previously committed sessions row. Only newly-created objects are eligible
// for cleanup.
func TestSessionsPushKeepsPreexistingRawOnMetadataFailure(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj, fake := newTestObjectStoreWithFake(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		sessionID  = "session-repush"
		agent      = "codex"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	key := rawKey(deviceID, agent, sessionID, started.UTC())
	fake.put(key, []byte("previously-committed-raw"))

	_, err := pool.Exec(ctx, `DROP TABLE turns CASCADE`)
	require.NoError(t, err)

	client := newPushClient(t, pool, obj, adminToken)
	pushReq := connect.NewRequest(&prosav1.PushRequest{
		Session: &prosav1.Session{
			Id:             sessionID,
			Agent:          agent,
			StartedAt:      timestamppb.New(started),
			LastActivityAt: timestamppb.New(started),
			RawHash:        "hash-repush",
			RawSize:        3,
		},
		Raw:   []byte("raw"),
		Turns: []*prosav1.Turn{{Role: "user", Content: "hi", Ts: timestamppb.New(started)}},
	})
	pushReq.Header().Set("Authorization", "Bearer "+bearer)

	_, err = client.Push(ctx, pushReq)
	require.Error(t, err)

	_, found := fake.object(key)
	require.True(t, found, "pre-existing raw object must not be deleted on failure")
}

func newPushClient(t *testing.T, pool *pgxpool.Pool, obj *storage.ObjectStore, adminToken string) prosav1connect.SessionsServiceClient {
	t.Helper()
	mux := http.NewServeMux()
	authSvc := auth.New(pool, adminToken, "http://panel.test")
	path, handler := prosav1connect.NewSessionsServiceHandler(
		NewSessionsHandler(pool, obj),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return prosav1connect.NewSessionsServiceClient(server.Client(), server.URL)
}
