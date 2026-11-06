package gemini

import (
	"context"
	"testing"

	"github.com/c3-oss/prosa/pkg/session"
	"github.com/stretchr/testify/require"
)

func TestRequestsIncludeThinkingAndToolInput(t *testing.T) {
	msgs := []message{
		{ID: "one", Type: "gemini", Model: "gemini-3.5-flash", Timestamp: "2026-10-14T12:00:00Z", Tokens: &geminiTokens{Input: 100, Cached: 30, Output: 20, Thought: 10, Tool: 5, Total: 135}},
		{ID: "two", Type: "gemini", Model: "gemini-3.8-flash", Tokens: &geminiTokens{Input: 10, Output: 5}},
	}
	msgs = append(msgs, msgs[0])
	sess, _, _, _, err := projectEnvelope(context.Background(), envelope{SessionID: "session", Messages: msgs})
	require.NoError(t, err)
	require.Len(t, sess.Requests, 2)
	require.Equal(t, session.RequestCoverageComplete, sess.RequestCoverage)
	require.Equal(t, int64(115), sess.Usage.InputTokens)
	require.Equal(t, int64(35), sess.Usage.OutputTokens)
	require.Equal(t, int64(150), sess.Usage.TotalTokens)
	require.Equal(t, "one", sess.Requests[0].ID)
	require.Equal(t, "gemini-3.8-flash", sess.Requests[1].Model)
	require.NotNil(t, sess.Requests[0].Timestamp)
}
