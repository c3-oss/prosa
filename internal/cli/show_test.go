package cli

import (
	"bytes"
	"context"
	"testing"

	"connectrpc.com/connect"
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
