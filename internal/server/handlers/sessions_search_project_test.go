package handlers

import (
	"context"
	"sort"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

func TestSessionsSearchProjectMatchFiltersPathRemoteOrMarker(t *testing.T) {
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
	started := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)

	push := func(id, path, remote, marker string, offset time.Duration) {
		t.Helper()
		raw := []byte("raw-" + id)
		req := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:             id,
				Agent:          "codex",
				ProjectPath:    path,
				ProjectRemote:  remote,
				ProjectMarker:  marker,
				StartedAt:      timestamppb.New(started.Add(offset)),
				LastActivityAt: timestamppb.New(started.Add(offset + time.Minute)),
				RawHash:        sha256Hex(raw),
				RawSize:        int64(len(raw)),
			},
			Turns: []*prosav1.Turn{{
				Role:    "user",
				Content: "needle project work",
				Ts:      timestamppb.New(started.Add(offset)),
			}},
			Raw: raw,
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		_, err := client.Push(ctx, req)
		require.NoError(t, err)
	}

	push("path-match", "/work/prosa", "", "", 0)
	push("remote-match", "/work/other", "git@github.com:c3-oss/prosa.git", "", time.Minute)
	push("marker-match", "/work/other", "", "c3-oss/prosa", 2*time.Minute)
	push("other-session", "/work/other", "git@github.com:c3-oss/other.git", "other", 3*time.Minute)

	req := connect.NewRequest(&prosav1.SearchRequest{
		Query:        "needle",
		Since:        timestamppb.New(started.Add(-time.Hour)),
		Until:        timestamppb.New(started.Add(time.Hour)),
		ProjectMatch: "prosa",
		Limit:        10,
	})
	req.Header().Set("Authorization", "Bearer "+bearer)
	resp, err := client.Search(ctx, req)
	require.NoError(t, err)

	ids := make([]string, 0, len(resp.Msg.Hits))
	for _, hit := range resp.Msg.Hits {
		ids = append(ids, hit.Session.Id)
	}
	sort.Strings(ids)
	require.Equal(t, []string{"marker-match", "path-match", "remote-match"}, ids)
}
