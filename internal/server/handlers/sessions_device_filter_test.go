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

func TestRemoteReadsAreCrossDeviceAndDeviceFilterMatchesNameOrID(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearerA    = "device-a-bearer"
		bearerB    = "device-b-bearer"
		deviceA    = "device-a"
		deviceB    = "device-b"
	)
	insertDeviceToken(t, ctx, pool, deviceA, bearerA)
	insertDeviceToken(t, ctx, pool, deviceB, bearerB)
	_, err := pool.Exec(ctx, `UPDATE devices SET friendly_name = $1 WHERE id = $2`, "homebox", deviceA)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE devices SET friendly_name = $1 WHERE id = $2`, "tbox", deviceB)
	require.NoError(t, err)

	client := newPushClient(t, pool, obj, adminToken)
	started := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	push := func(id, bearer, project, prompt string, offset time.Duration) {
		t.Helper()
		raw := []byte("raw-" + id)
		req := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:             id,
				Agent:          "codex",
				ProjectPath:    project,
				StartedAt:      timestamppb.New(started.Add(offset)),
				LastActivityAt: timestamppb.New(started.Add(offset + time.Minute)),
				FirstPrompt:    prompt,
				RawHash:        sha256Hex(raw),
				RawSize:        int64(len(raw)),
			},
			Turns: []*prosav1.Turn{{
				Role:    "user",
				Content: prompt,
				Ts:      timestamppb.New(started.Add(offset)),
			}},
			Raw: raw,
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		_, err := client.Push(ctx, req)
		require.NoError(t, err)
	}
	push("homebox-session", bearerA, "/homebox/prosa", "linux timeline work", 0)
	push("tbox-session", bearerB, "/Users/cai/Projects/prosa", "macos timeline work", time.Minute)

	list := func(req *prosav1.ListRequest) *prosav1.ListResponse {
		t.Helper()
		req.Since = timestamppb.New(started.Add(-time.Hour))
		req.Until = timestamppb.New(started.Add(time.Hour))
		req.Limit = 10
		r := connect.NewRequest(req)
		r.Header().Set("Authorization", "Bearer "+bearerA)
		resp, err := client.List(ctx, r)
		require.NoError(t, err)
		return resp.Msg
	}

	all := list(&prosav1.ListRequest{})
	require.Equal(t, int64(2), all.TotalCount)
	require.Len(t, all.Sessions, 2)

	byName := list(&prosav1.ListRequest{DeviceName: "tbox"})
	require.Equal(t, int64(1), byName.TotalCount)
	require.Len(t, byName.Sessions, 1)
	require.Equal(t, "tbox-session", byName.Sessions[0].Id)
	require.Equal(t, deviceB, byName.Sessions[0].DeviceId)

	byID := list(&prosav1.ListRequest{DeviceName: deviceB})
	require.Equal(t, int64(1), byID.TotalCount)
	require.Len(t, byID.Sessions, 1)
	require.Equal(t, "tbox-session", byID.Sessions[0].Id)

	searchReq := connect.NewRequest(&prosav1.SearchRequest{
		Query:      "macos",
		Since:      timestamppb.New(started.Add(-time.Hour)),
		Until:      timestamppb.New(started.Add(time.Hour)),
		DeviceName: deviceB,
		Limit:      10,
	})
	searchReq.Header().Set("Authorization", "Bearer "+bearerA)
	searchResp, err := client.Search(ctx, searchReq)
	require.NoError(t, err)
	require.Len(t, searchResp.Msg.Hits, 1)
	require.Equal(t, "tbox-session", searchResp.Msg.Hits[0].Session.Id)

	getReq := connect.NewRequest(&prosav1.GetRequest{Id: "tbox-session"})
	getReq.Header().Set("Authorization", "Bearer "+bearerA)
	getResp, err := client.Get(ctx, getReq)
	require.NoError(t, err)
	require.Equal(t, deviceB, getResp.Msg.Session.DeviceId)

	rawReq := connect.NewRequest(&prosav1.GetRawRequest{Id: "tbox-session"})
	rawReq.Header().Set("Authorization", "Bearer "+bearerA)
	rawResp, err := client.GetRaw(ctx, rawReq)
	require.NoError(t, err)
	require.Equal(t, []byte("raw-tbox-session"), rawResp.Msg.Chunk)

	manifestReq := connect.NewRequest(&prosav1.ManifestRequest{Limit: 10})
	manifestReq.Header().Set("Authorization", "Bearer "+bearerA)
	manifestResp, err := client.Manifest(ctx, manifestReq)
	require.NoError(t, err)
	require.Len(t, manifestResp.Msg.Entries, 1)
	require.Equal(t, "homebox-session", manifestResp.Msg.Entries[0].Id)
}
