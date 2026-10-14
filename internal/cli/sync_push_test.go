package cli

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/pkg/session"
)

func TestPushProtoSanitizesDerivedText(t *testing.T) {
	projectPath := "/tmp/a\x00b"
	projectRemote := "git@example.com:a\x00b.git"
	projectMarker := "marker\x00name"
	firstPrompt := "hello\x00world"
	model := "model\x00name"
	parentID := "parent-session-id"
	now := time.Now().UTC()

	sess := session.Session{
		ID:              "session\x00id",
		Agent:           "codex",
		DeviceID:        "device\x00id",
		ProjectPath:     &projectPath,
		ProjectRemote:   &projectRemote,
		ProjectMarker:   &projectMarker,
		StartedAt:       now,
		LastActivityAt:  now,
		FirstPrompt:     &firstPrompt,
		Model:           &model,
		RawHash:         "hash\x00value",
		RawSize:         123,
		ParentSessionID: &parentID,
	}
	gotSession := sessionToProto(sess)
	require.Equal(t, "session\x00id", gotSession.Id)
	require.Equal(t, "device\x00id", gotSession.DeviceId)
	require.Equal(t, "hash\x00value", gotSession.RawHash)
	require.Equal(t, "/tmp/a b", gotSession.ProjectPath)
	require.Equal(t, "git@example.com:a b.git", gotSession.ProjectRemote)
	require.Equal(t, "marker name", gotSession.ProjectMarker)
	require.Equal(t, "hello world", gotSession.FirstPrompt)
	require.Equal(t, "model name", gotSession.Model)
	require.Equal(t, "parent-session-id", gotSession.ParentSessionId)

	gotTurns := turnsToProto([]session.Turn{{
		Role:      "tool\x00role",
		Content:   "content\x00body",
		Timestamp: now,
		Kind:      "kind\x00name",
		ToolName:  "tool\x00name",
	}})
	require.Len(t, gotTurns, 1)
	require.Equal(t, "tool role", gotTurns[0].Role)
	require.Equal(t, "content body", gotTurns[0].Content)
	require.Equal(t, "kind name", gotTurns[0].Kind)
	require.Equal(t, "tool name", gotTurns[0].ToolName)

	gotTools := toolsToProto([]session.ToolUsage{{Name: "read\x00file", Count: 2}})
	require.Len(t, gotTools, 1)
	require.Equal(t, "read file", gotTools[0].Name)
	require.Equal(t, int32(2), gotTools[0].Count)
}

func TestPushSessionTransportsStoredRequestsAndProjectionVersion(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "request-wire")
	sess, err := fx.store.GetSession(ctx, "request-wire")
	require.NoError(t, err)
	at := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	zero := int64(0)
	tier := "standard"
	sess.ProjectionVersion = session.ProjectionVersion - 1
	sess.RequestCoverage = session.RequestCoverageComplete
	sess.Requests = []session.RequestUsage{
		{
			ID: "request", Model: "gpt-6.1-sol", Timestamp: &at,
			Usage:        session.TokenUsage{InputTokens: 12, CacheCreationTokens: 2},
			PromptTokens: &zero, ServiceTier: &tier, CacheCreation5mTokens: &zero,
		},
		{ID: "missing-options", Model: "claude-sonnet-5-5"},
	}
	require.NoError(t, fx.store.UpsertSession(ctx, sess, nil))
	outcome, err := fx.pusher.pushSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, pushImported, outcome)
	require.Len(t, fx.fake.pushed, 1)
	got := fx.fake.pushed[0]
	require.EqualValues(t, sess.ProjectionVersion, got.Session.ProjectionVersion)
	require.Equal(t, session.RequestCoverageComplete, got.Session.RequestCoverage)
	require.Len(t, got.Requests, 2)
	require.Equal(t, at, got.Requests[0].Timestamp.AsTime())
	require.Equal(t, &zero, got.Requests[0].PromptTokens)
	require.Equal(t, &tier, got.Requests[0].ServiceTier)
	require.Equal(t, &zero, got.Requests[0].CacheCreation_5MTokens)
	require.EqualValues(t, 2, got.Requests[0].Usage.CacheCreationTokens)
	require.Nil(t, got.Requests[1].Timestamp)
	require.Nil(t, got.Requests[1].PromptTokens)
	require.Nil(t, got.Requests[1].ServiceTier)
	require.Nil(t, got.Requests[1].CacheCreation_5MTokens)
}

type chunkRecordingClient struct {
	fakeSessionsClient
	chunks []*prosav1.PushChunkRequest
}

func (f *chunkRecordingClient) PushChunk(_ context.Context, req *connect.Request[prosav1.PushChunkRequest]) (*connect.Response[prosav1.PushChunkResponse], error) {
	f.chunks = append(f.chunks, req.Msg)
	return connect.NewResponse(&prosav1.PushChunkResponse{Accepted: !req.Msg.Final}), nil
}

func TestPushChunkTransportsRequestsOnlyWithFinalChunk(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "chunk-requests")
	sess, err := fx.store.GetSession(ctx, "chunk-requests")
	require.NoError(t, err)
	raw := strings.Repeat("r", chunkPushChunkBytes+7)
	sess.RawPath = fx.writeRaw(t, sess.Agent, "chunk-requests.jsonl", raw)
	sess.RawSize = int64(len(raw))
	sess.RequestCoverage = session.RequestCoverageComplete
	sess.Requests = []session.RequestUsage{{ID: "call", Model: "gpt-6.1-sol"}}
	client := &chunkRecordingClient{}
	fx.pusher.client = client
	outcome, err := fx.pusher.pushSessionChunked(ctx, sess, nil, nil, sess.RawPath)
	require.NoError(t, err)
	require.Equal(t, pushImported, outcome)
	require.Len(t, client.chunks, 2)
	require.Empty(t, client.chunks[0].Requests)
	require.False(t, client.chunks[0].Final)
	require.Len(t, client.chunks[1].Requests, 1)
	require.True(t, client.chunks[1].Final)
	require.Equal(t, "call", client.chunks[1].Requests[0].Id)
	require.EqualValues(t, sess.ProjectionVersion, client.chunks[1].Session.ProjectionVersion)
}

func TestPushRejectsOversizedFinalProjection(t *testing.T) {
	tooLarge := &prosav1.PushChunkRequest{
		Session:  &prosav1.Session{Id: "large"},
		Final:    true,
		Requests: []*prosav1.RequestUsage{{Id: strings.Repeat("r", maxPushMessageBytes)}},
	}
	require.ErrorContains(t, validatePushChunkSize(tooLarge), "exceeding")
}

func TestShouldChunkPush(t *testing.T) {
	require.False(t, shouldChunkPush(chunkPushThresholdBytes))
	require.True(t, shouldChunkPush(chunkPushThresholdBytes+1))
}

func TestIsRemoteUnavailableClassifiesTransportErrors(t *testing.T) {
	dialErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("i/o timeout")}
	require.True(t, isRemoteUnavailable(dialErr))
	require.True(t, isRemoteUnavailable(fmt.Errorf("push rpc: %w", dialErr)))
	require.True(t, isRemoteUnavailable(connect.NewError(connect.CodeUnavailable, errors.New("down"))))
	require.True(t, isRemoteUnavailable(connect.NewError(connect.CodeDeadlineExceeded, errors.New("slow"))))
	require.False(t, isRemoteUnavailable(connect.NewError(connect.CodeInvalidArgument, errors.New("bad"))))
	require.False(t, isRemoteUnavailable(errors.New("plain failure")))
	require.False(t, isRemoteUnavailable(nil))
}
