package handlers

import (
	"context"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// List must narrow on the repeated agents / project_matches fields
// server-side, so total_count and pagination reflect the filter — not the
// unfiltered corpus. See issue #79.
func TestSessionsListMultiSelectNarrowing(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)
	client := newPushClient(t, pool, obj, adminToken)
	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)

	push := func(id, agent, marker string) {
		req := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:             id,
				Agent:          agent,
				ProjectMarker:  marker,
				StartedAt:      timestamppb.New(started),
				LastActivityAt: timestamppb.New(started),
				RawHash:        "hash-" + id,
				RawSize:        3,
			},
			Raw: []byte("raw"),
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		_, err := client.Push(ctx, req)
		require.NoError(t, err)
	}

	// 3 codex (alpha), 2 claude-code (beta).
	for i := 0; i < 3; i++ {
		push(fmt.Sprintf("cdx-%d", i), "codex", "alpha")
	}
	for i := 0; i < 2; i++ {
		push(fmt.Sprintf("cc-%d", i), "claude-code", "beta")
	}

	list := func(req *prosav1.ListRequest) *prosav1.ListResponse {
		req.Since = timestamppb.New(started.Add(-time.Hour))
		req.Until = timestamppb.New(started.Add(time.Hour))
		r := connect.NewRequest(req)
		r.Header().Set("Authorization", "Bearer "+bearer)
		resp, err := client.List(ctx, r)
		require.NoError(t, err)
		return resp.Msg
	}

	t.Run("single agent in list", func(t *testing.T) {
		msg := list(&prosav1.ListRequest{Agents: []string{"codex"}, Limit: 50})
		require.Equal(t, int64(3), msg.TotalCount)
		require.Len(t, msg.Sessions, 3)
		for _, s := range msg.Sessions {
			require.Equal(t, "codex", s.Agent)
		}
	})

	t.Run("two agents", func(t *testing.T) {
		msg := list(&prosav1.ListRequest{Agents: []string{"codex", "claude-code"}, Limit: 50})
		require.Equal(t, int64(5), msg.TotalCount)
		require.Len(t, msg.Sessions, 5)
	})

	t.Run("project_matches narrows", func(t *testing.T) {
		msg := list(&prosav1.ListRequest{ProjectMatches: []string{"alpha"}, Limit: 50})
		require.Equal(t, int64(3), msg.TotalCount)
		require.Len(t, msg.Sessions, 3)
	})

	t.Run("total_count reflects filter under pagination", func(t *testing.T) {
		// The original bug: total_count showed the unfiltered corpus while a
		// short filtered page rendered. Here a Limit=2 page must still report
		// the filtered total of 3.
		msg := list(&prosav1.ListRequest{Agents: []string{"codex"}, Limit: 2})
		require.Equal(t, int64(3), msg.TotalCount)
		require.Len(t, msg.Sessions, 2)
	})
}
