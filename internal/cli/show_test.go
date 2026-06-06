package cli

import (
	"bytes"
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/pkg/session"
)

type fakeRawClient struct {
	responses []*prosav1.GetRawResponse
	requests  []*prosav1.GetRawRequest
}

func (f *fakeRawClient) GetRaw(_ context.Context, req *connect.Request[prosav1.GetRawRequest]) (*connect.Response[prosav1.GetRawResponse], error) {
	f.requests = append(f.requests, req.Msg)
	if len(f.responses) == 0 {
		return connect.NewResponse(&prosav1.GetRawResponse{Eof: true}), nil
	}
	resp := f.responses[0]
	f.responses = f.responses[1:]
	return connect.NewResponse(resp), nil
}

func TestStreamRemoteRawWritesChunks(t *testing.T) {
	client := &fakeRawClient{responses: []*prosav1.GetRawResponse{
		{Chunk: []byte("abc"), TotalSize: 6},
		{Chunk: []byte("def"), TotalSize: 6, Eof: true},
	}}

	var out bytes.Buffer
	err := streamRemoteRaw(context.Background(), client, "s1", &out)
	require.NoError(t, err)
	require.Equal(t, "abcdef", out.String())
	require.Len(t, client.requests, 2)
	require.Equal(t, "s1", client.requests[0].Id)
	require.Equal(t, int64(0), client.requests[0].Offset)
	require.Equal(t, int64(3), client.requests[1].Offset)
	require.Equal(t, int32(showRemoteRawChunkLimit), client.requests[0].Limit)
}

func TestCapShowPayloadLines(t *testing.T) {
	payload := showPayload{
		Turns: []session.Turn{
			{Role: "tool", Content: "line1\nline2\nline3"},
		},
	}
	got := capShowPayloadLines(payload, 2)
	require.Equal(t, "line1\nline2\n…", got.Turns[0].Content)
	require.Equal(t, "line1\nline2\nline3", payload.Turns[0].Content, "input payload must not be mutated")
}

func TestSelectShowOutputMode(t *testing.T) {
	cases := []struct {
		name        string
		jsonMode    bool
		raw         bool
		remote      bool
		interactive bool
		want        showOutputMode
	}{
		{
			name:        "json wins over remote raw",
			jsonMode:    true,
			raw:         true,
			remote:      true,
			interactive: true,
			want:        showModeJSON,
		},
		{
			name:        "explicit remote raw streams raw",
			raw:         true,
			remote:      true,
			interactive: true,
			want:        showModeRemoteRaw,
		},
		{
			name:        "remote pipe fallback streams raw",
			remote:      true,
			interactive: false,
			want:        showModeRemoteRaw,
		},
		{
			name:        "local raw uses local file",
			raw:         true,
			interactive: true,
			want:        showModeLocalRaw,
		},
		{
			name:        "interactive default renders",
			interactive: true,
			want:        showModeRendered,
		},
		{
			name: "local pipe fallback uses local raw file",
			want: showModeLocalPipeRaw,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := selectShowOutputMode(tc.jsonMode, tc.raw, tc.remote, tc.interactive)
			require.Equal(t, tc.want, got)
		})
	}
}

func TestRunShowRemoteRawNoLongerRejectsFlagPair(t *testing.T) {
	originalFlags := g
	originalRaw := showRawFlag
	originalRemote := showRemoteFlag
	originalMaxLines := showMaxOutputLines
	t.Cleanup(func() {
		g = originalFlags
		showRawFlag = originalRaw
		showRemoteFlag = originalRemote
		showMaxOutputLines = originalMaxLines
	})

	t.Setenv("PROSA_CONFIG_HOME", t.TempDir())
	g.JSON = false
	showRawFlag = true
	showRemoteFlag = true
	showMaxOutputLines = 0

	err := runShow(&cobra.Command{}, []string{"s1"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "not logged in")
	require.NotContains(t, err.Error(), "mutually exclusive")
}
