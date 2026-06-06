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

// A sessions row without a sync_state row must still appear in Manifest
// (with an empty hash) so reconcile re-pushes it instead of silently
// dropping it. See issue #109.
func TestManifestSurfacesSessionsWithoutSyncState(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		sessionID  = "session-orphan"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)
	client := newPushClient(t, pool, obj, adminToken)
	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)

	push := connect.NewRequest(&prosav1.PushRequest{
		Session: &prosav1.Session{
			Id:             sessionID,
			Agent:          "codex",
			StartedAt:      timestamppb.New(started),
			LastActivityAt: timestamppb.New(started),
			RawHash:        sha256Hex([]byte("raw")),
			RawSize:        3,
		},
		Raw: []byte("raw"),
	})
	push.Header().Set("Authorization", "Bearer "+bearer)
	_, err := client.Push(ctx, push)
	require.NoError(t, err)

	// Simulate a session that never got (or lost) its sync_state row.
	_, err = pool.Exec(ctx, `DELETE FROM sync_state WHERE session_id = $1`, sessionID)
	require.NoError(t, err)

	req := connect.NewRequest(&prosav1.ManifestRequest{Limit: 100})
	req.Header().Set("Authorization", "Bearer "+bearer)
	resp, err := client.Manifest(ctx, req)
	require.NoError(t, err)

	var found *prosav1.ManifestEntry
	for _, e := range resp.Msg.Entries {
		if e.Id == sessionID {
			found = e
		}
	}
	require.NotNil(t, found, "session without sync_state must still appear in the manifest")
	require.Empty(t, found.RawHash, "missing sync_state surfaces an empty hash so reconcile re-pushes")
	require.EqualValues(t, 0, found.ProjectionVersion)
}
