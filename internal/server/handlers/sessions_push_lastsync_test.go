package handlers

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// An idempotent re-push (same hash, current projection) returns Skipped
// but is still a successful sync, so it must bump devices.last_sync —
// otherwise an active-but-converged device looks dormant to the panel.
// See issue #93.
func TestSessionsPushBumpsLastSyncOnIdempotentSkip(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		sessionID  = "session-idem"
		agent      = "codex"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	client := newPushClient(t, pool, obj, adminToken)
	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)

	newReq := func() *connect.Request[prosav1.PushRequest] {
		r := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:             sessionID,
				Agent:          agent,
				StartedAt:      timestamppb.New(started),
				LastActivityAt: timestamppb.New(started),
				RawHash:        "hash-idem",
				RawSize:        3,
				Usage:          &prosav1.TokenUsage{TotalTokens: 1},
			},
			Raw:   []byte("raw"),
			Turns: []*prosav1.Turn{{Role: "user", Content: "hi", Ts: timestamppb.New(started)}},
		})
		r.Header().Set("Authorization", "Bearer "+bearer)
		return r
	}

	// First push stores the session (not skipped).
	resp, err := client.Push(ctx, newReq())
	require.NoError(t, err)
	require.False(t, resp.Msg.Skipped)

	// Backdate last_sync so we can prove the re-push advances it.
	baseline := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	_, err = pool.Exec(ctx, `UPDATE devices SET last_sync = $1 WHERE id = $2`, baseline, deviceID)
	require.NoError(t, err)

	// Identical re-push: skipped, but last_sync must move forward.
	resp, err = client.Push(ctx, newReq())
	require.NoError(t, err)
	require.True(t, resp.Msg.Skipped, "identical re-push should short-circuit")

	var lastSync time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT last_sync FROM devices WHERE id = $1`, deviceID).Scan(&lastSync))
	require.True(t, lastSync.After(baseline), "idempotent skip must bump last_sync, got %s", lastSync)
}

func TestSessionsPushDoesNotRewriteFreshLastSync(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		agent      = "codex"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	client := newPushClient(t, pool, obj, adminToken)
	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)

	newReq := func(id string) *connect.Request[prosav1.PushRequest] {
		r := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:             id,
				Agent:          agent,
				StartedAt:      timestamppb.New(started),
				LastActivityAt: timestamppb.New(started),
				RawHash:        "hash-" + id,
				RawSize:        3,
				Usage:          &prosav1.TokenUsage{TotalTokens: 1},
			},
			Raw:   []byte("raw"),
			Turns: []*prosav1.Turn{{Role: "user", Content: "hi", Ts: timestamppb.New(started)}},
		})
		r.Header().Set("Authorization", "Bearer "+bearer)
		return r
	}

	resp, err := client.Push(ctx, newReq("session-fresh-a"))
	require.NoError(t, err)
	require.False(t, resp.Msg.Skipped)

	var firstLastSync time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT last_sync FROM devices WHERE id = $1`, deviceID).Scan(&firstLastSync))

	resp, err = client.Push(ctx, newReq("session-fresh-b"))
	require.NoError(t, err)
	require.False(t, resp.Msg.Skipped)

	var secondLastSync time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT last_sync FROM devices WHERE id = $1`, deviceID).Scan(&secondLastSync))
	require.True(t, secondLastSync.Equal(firstLastSync),
		"fresh last_sync should not be rewritten; first=%s second=%s", firstLastSync, secondLastSync)
}
