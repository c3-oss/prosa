package claudecode

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/c3-oss/prosa/pkg/session"
	"github.com/stretchr/testify/require"
)

func TestRequestIterationsDeduplicateAndPreserveBilling(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	record := `{"type":"assistant","requestId":"req","timestamp":"2026-10-14T12:00:00Z","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":100,"output_tokens":3,"service_tier":"priority","speed":"fast","inference_geo":"us","iterations":[{"type":"message","input_tokens":50,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":4}},{"type":"advisor_message","model":"claude-opus-5-5","input_tokens":20,"output_tokens":5},{"type":"compaction","model":"claude-haiku-5-5","input_tokens":50,"output_tokens":2}]}}}`
	require.NoError(t, os.WriteFile(path, []byte(record+"\n"+record+"\n"), 0o600))
	sess, _, _, _, err := parseSession(context.Background(), path, slog.Default())
	require.NoError(t, err)
	require.Len(t, sess.Requests, 3)
	require.Equal(t, session.RequestCoverageComplete, sess.RequestCoverage)
	require.Equal(t, int64(134), sess.Usage.TotalTokens)
	require.Equal(t, "req:iteration:0", sess.Requests[0].ID)
	require.Equal(t, "claude-sonnet-5-5", sess.Requests[0].Model)
	require.Equal(t, int64(56), *sess.Requests[0].PromptTokens)
	require.Equal(t, int64(2), *sess.Requests[0].CacheCreation5mTokens)
	require.Equal(t, int64(4), *sess.Requests[0].CacheCreation1hTokens)
	require.Equal(t, "fast", *sess.Requests[0].Speed)
	require.Equal(t, "priority", *sess.Requests[0].ServiceTier)
	require.NotNil(t, sess.Requests[0].Timestamp)
	require.Equal(t, "claude-opus-5-5", sess.Requests[1].Model)
	require.Nil(t, sess.Requests[1].ServiceTier)
	require.Equal(t, "claude-haiku-5-5", sess.Requests[2].Model)
}

func TestRequestMalformedLineMarksPartial(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	require.NoError(t, os.WriteFile(path, []byte(`{"type":"assistant","requestId":"a","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1}}}`+"\n{\n"), 0o600))
	sess, _, _, _, err := parseSession(context.Background(), path, slog.Default())
	require.NoError(t, err)
	require.Equal(t, session.RequestCoveragePartial, sess.RequestCoverage)
	require.Len(t, sess.Requests, 1)
}
