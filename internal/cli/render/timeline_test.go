package render

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func strp(s string) *string { return &s }

func TestTimelineItemsInteractiveRailAndTools(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.Local)
	item := TimelineItem{
		Session: session.Session{
			ID:             "s1",
			Agent:          "claude-code",
			DeviceID:       "laptop",
			ProjectPath:    strp("/Users/upsetbit/Projects/c3/c3-oss/prosa"),
			StartedAt:      now.Add(-10 * time.Minute),
			LastActivityAt: now.Add(-5 * time.Minute),
			FirstPrompt:    strp("setup importer tests"),
		},
		Tools: []session.ToolUsage{
			{Name: "write", Count: 3},
			{Name: "grep", Count: 2},
			{Name: "bash", Count: 1},
			{Name: "read", Count: 1},
		},
	}

	var b bytes.Buffer
	err := TimelineItems(&b, []TimelineItem{item}, now, TimelineOptions{
		Interactive: true,
		Width:       96,
		Layout:      TimelineScoped,
	})
	require.NoError(t, err)
	out := b.String()

	require.Contains(t, out, "Today")
	require.Contains(t, out, "│")
	require.Contains(t, out, "11:50")
	require.Contains(t, out, "*")
	require.Contains(t, out, "claude")
	require.Contains(t, out, "prosa")
	require.Contains(t, out, `"setup importer tests"`)
	require.Contains(t, out, "└")
	require.Contains(t, out, "5min · write, grep, bash")
	require.NotContains(t, out, "read")
}

func TestTimelineItemsPlainKeepsStableRows(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.Local)
	item := TimelineItem{
		Session: session.Session{
			ID:             "s1",
			Agent:          "codex",
			DeviceID:       "laptop",
			ProjectPath:    strp("/work/prosa"),
			StartedAt:      now.Add(-time.Hour),
			LastActivityAt: now.Add(-30 * time.Minute),
			FirstPrompt:    strp("refactor sync logic"),
		},
		Tools: []session.ToolUsage{{Name: "bash", Count: 1}},
	}

	var b bytes.Buffer
	err := TimelineItems(&b, []TimelineItem{item}, now, TimelineOptions{Interactive: false})
	require.NoError(t, err)
	out := b.String()

	want := fmt.Sprintf("%s\tlaptop\tcodex\t/work/prosa\t30min\trefactor sync logic",
		item.Session.StartedAt.UTC().Format(time.RFC3339))
	require.Contains(t, out, want)
	require.NotContains(t, out, "│")
	require.NotContains(t, out, "└")
	require.False(t, strings.Contains(out, "\x1b["), "plain output must not contain ANSI escapes")
}
