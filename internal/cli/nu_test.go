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
	"github.com/c3-oss/prosa/pkg/session"
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
			Profile:        "work",
			Kinds:          []string{"goal"},
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
	require.Equal(t, "remote-session", row["id"])
	require.Equal(t, "device-b", row["device_id"])
	require.Equal(t, "work", row["profile"])
	require.NotContains(t, row, "ID")
	require.NotContains(t, row, "DeviceID")
}

func TestTimelineSessionPayloadUsesStableJSONSchema(t *testing.T) {
	projectPath := "/Users/cai/Projects/prosa"
	projectRemote := "git@github.com:c3-oss/prosa.git"
	projectMarker := "prosa"
	firstPrompt := "fix timeline json"
	model := "gpt-5-codex"
	parent := "parent-session"
	started := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	payload := timelineSessionPayload(session.Session{
		ID:              "s1",
		Agent:           "codex",
		DeviceID:        "device-a",
		ProjectPath:     &projectPath,
		ProjectRemote:   &projectRemote,
		ProjectMarker:   &projectMarker,
		StartedAt:       started,
		LastActivityAt:  started.Add(time.Minute),
		FirstPrompt:     &firstPrompt,
		Model:           &model,
		RawPath:         "/tmp/s1.jsonl",
		RawHash:         "hash",
		RawSize:         42,
		Usage:           &session.TokenUsage{TotalTokens: 10, InputTokens: 7, OutputTokens: 3},
		ParentSessionID: &parent,
		Profile:         "work",
		Kinds:           []string{"goal"},
	})

	body, err := json.Marshal(payload)
	require.NoError(t, err)
	var row map[string]any
	require.NoError(t, json.Unmarshal(body, &row))
	require.Equal(t, "s1", row["id"])
	require.Equal(t, "codex", row["agent"])
	require.Equal(t, "device-a", row["device_id"])
	require.Equal(t, "prosa", row["project"])
	require.Equal(t, projectPath, row["project_path"])
	require.Equal(t, projectRemote, row["project_remote"])
	require.Equal(t, projectMarker, row["project_marker"])
	require.Equal(t, "2026-06-22T12:00:00Z", row["started_at"])
	require.Equal(t, "fix timeline json", row["first_prompt"])
	require.Equal(t, "parent-session", row["parent_session_id"])
	require.Equal(t, "work", row["profile"])
	require.Equal(t, []any{"goal"}, row["kinds"])
	usage := row["usage"].(map[string]any)
	require.Equal(t, float64(10), usage["total_tokens"])
	require.Equal(t, float64(7), usage["input_tokens"])
	require.Equal(t, float64(3), usage["output_tokens"])
	require.NotContains(t, row, "ID")
	require.NotContains(t, row, "StartedAt")
	require.NotContains(t, row, "DeviceID")
}
