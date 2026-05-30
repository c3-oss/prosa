package render

import (
	"bytes"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestShowSessionHumanView(t *testing.T) {
	now := time.Date(2026, 5, 30, 15, 0, 0, 0, time.Local)
	detail := SessionDetail{
		Session: session.Session{
			ID:             "57f476a0-8e11-4f6d-83a0-5b1e4df16337",
			Agent:          "claude-code",
			DeviceID:       "laptop",
			ProjectPath:    strp("/work/prosa"),
			StartedAt:      now.Add(-time.Hour),
			LastActivityAt: now.Add(-30 * time.Minute),
			Model:          strp("claude-sonnet"),
			RawPath:        "/tmp/raw.jsonl",
		},
		Tools: []session.ToolUsage{{Name: "Edit", Count: 2}, {Name: "Bash", Count: 1}},
		Turns: []session.Turn{
			{Role: "user", Content: "fix this\n\nuse tests"},
			{Role: "assistant", Content: "done"},
		},
		Width: 96,
	}

	var b bytes.Buffer
	err := ShowSession(&b, detail)
	require.NoError(t, err)
	out := b.String()

	require.Contains(t, out, "session")
	require.Contains(t, out, "57f476a0-8e11-4f6d-83a0-5b1e4df16337")
	require.Contains(t, out, "claude")
	require.Contains(t, out, "prosa")
	require.Contains(t, out, "claude-sonnet")
	require.Contains(t, out, "Edit, Bash")
	require.Contains(t, out, "/tmp/raw.jsonl")
	require.Contains(t, out, "turns")
	require.Contains(t, out, "fix this use tests")
	require.NotContains(t, out, "fix this\n\nuse tests")
}
