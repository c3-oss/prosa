package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/cli/rpc"
)

type fakeNuSessions struct {
	prosav1connect.UnimplementedSessionsServiceHandler
	got *prosav1.ListRequest
}

func (f *fakeNuSessions) List(_ context.Context, req *connect.Request[prosav1.ListRequest]) (*connect.Response[prosav1.ListResponse], error) {
	f.got = req.Msg
	return connect.NewResponse(&prosav1.ListResponse{
		Sessions: []*prosav1.Session{{
			Id:             "remote-session",
			Agent:          "codex",
			DeviceId:       "device-b",
			ProjectPath:    "/Users/cai/Projects/prosa",
			StartedAt:      timestamppb.New(time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)),
			LastActivityAt: timestamppb.New(time.Date(2026, 6, 22, 12, 1, 0, 0, time.UTC)),
			FirstPrompt:    "remote timeline work",
			RawHash:        "hash",
			RawSize:        4,
		}},
		TotalCount: 1,
	}), nil
}

type fakeNuDevices struct {
	prosav1connect.UnimplementedDevicesServiceHandler
}

func (f fakeNuDevices) List(context.Context, *connect.Request[prosav1.DevicesServiceListRequest]) (*connect.Response[prosav1.DevicesServiceListResponse], error) {
	return connect.NewResponse(&prosav1.DevicesServiceListResponse{
		Devices: []*prosav1.Device{{Id: "device-b", FriendlyName: "tbox"}},
	}), nil
}

func TestRunNuRemoteListsWithoutLocalStore(t *testing.T) {
	originalFlags := g
	originalStdout := os.Stdout
	t.Cleanup(func() {
		g = originalFlags
		os.Stdout = originalStdout
	})
	t.Setenv("PROSA_CONFIG_HOME", t.TempDir())
	t.Setenv("PROSA_HOME", t.TempDir())

	sessions := &fakeNuSessions{}
	mux := http.NewServeMux()
	sessionsPath, sessionsHandler := prosav1connect.NewSessionsServiceHandler(sessions)
	mux.Handle(sessionsPath, sessionsHandler)
	devicesPath, devicesHandler := prosav1connect.NewDevicesServiceHandler(fakeNuDevices{})
	mux.Handle(devicesPath, devicesHandler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	require.NoError(t, rpc.SaveAuth(rpc.AuthFile{
		Server:   server.URL,
		DeviceID: "device-a",
		Token:    "token",
	}))

	g = globalFlags{
		All:     true,
		JSON:    true,
		Agent:   "codex",
		Device:  "device-b",
		Profile: "work",
		Limit:   1,
	}
	now := time.Date(2026, 6, 22, 13, 0, 0, 0, time.UTC)
	w := Window{
		Since:     now.Add(-24 * time.Hour),
		Until:     now,
		LastLabel: "24h",
	}

	r, wpipe, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout = wpipe
	err = runNuRemote(context.Background(), w, now)
	require.NoError(t, wpipe.Close())
	require.NoError(t, err)

	var out bytes.Buffer
	_, err = io.Copy(&out, r)
	require.NoError(t, err)
	require.NoError(t, r.Close())

	require.NotNil(t, sessions.got)
	require.Equal(t, "codex", sessions.got.Agent)
	require.Equal(t, "device-b", sessions.got.DeviceName)
	require.Equal(t, "work", sessions.got.Profile)
	require.Equal(t, int32(1), sessions.got.Limit)

	var row map[string]any
	require.NoError(t, json.Unmarshal(bytes.TrimSpace(out.Bytes()), &row))
	require.Equal(t, "remote-session", row["ID"])
	require.Equal(t, "device-b", row["DeviceID"])
}
