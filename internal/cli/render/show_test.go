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

func TestShowSessionRendersToolKindLabel(t *testing.T) {
	now := time.Date(2026, 5, 30, 15, 0, 0, 0, time.Local)
	detail := SessionDetail{
		Session: session.Session{
			ID:             "abc",
			Agent:          "claude-code",
			DeviceID:       "laptop",
			StartedAt:      now,
			LastActivityAt: now,
			RawPath:        "/tmp/raw.jsonl",
		},
		Turns: []session.Turn{
			{Role: "user", Content: "build the binary", Kind: session.KindMessage},
			{
				Role:     "tool",
				Content:  "build failed: undefined Foo",
				Kind:     session.KindToolResult,
				ToolName: "Bash",
			},
		},
		Width: 96,
	}
	var b bytes.Buffer
	require.NoError(t, ShowSession(&b, detail))
	out := b.String()
	require.Contains(t, out, "tool:Bash", "tool turn should render with tool:<name> label")
	require.Contains(t, out, "build failed")
}

func TestShowSessionRespectsMaxOutputLines(t *testing.T) {
	now := time.Date(2026, 5, 30, 15, 0, 0, 0, time.Local)
	body := "line1\nline2\nline3\nline4\nline5"
	detail := SessionDetail{
		Session: session.Session{
			ID:             "abc",
			Agent:          "claude-code",
			DeviceID:       "laptop",
			StartedAt:      now,
			LastActivityAt: now,
			RawPath:        "/tmp/raw.jsonl",
		},
		Turns: []session.Turn{
			{
				Role: "tool", Content: body,
				Kind: session.KindToolResult, ToolName: "Bash",
			},
		},
		Width:          96,
		MaxOutputLines: 2,
	}
	var b bytes.Buffer
	require.NoError(t, ShowSession(&b, detail))
	out := b.String()
	require.Contains(t, out, "line1")
	require.Contains(t, out, "line2")
	require.NotContains(t, out, "line3", "lines past the cap should be dropped")
	require.Contains(t, out, "…", "truncation sentinel should appear")
}
