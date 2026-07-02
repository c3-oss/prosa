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
			ID:             "12345678-abcd-4ef0-9012-3456789abcde",
			Agent:          "claude-code",
			DeviceID:       "laptop",
			ProjectPath:    strp("/Users/upsetbit/Projects/c3/c3-oss/prosa"),
			StartedAt:      now.Add(-10 * time.Minute),
			LastActivityAt: now.Add(-5 * time.Minute),
			FirstPrompt:    strp("setup importer\n\ntests"),
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
		// Use Global + explicit slots so device + project both render
		// (the scope-aware suppression for Scoped would drop project,
		// and a single item naturally has cardinality 1).
		Layout: TimelineGlobal,
		Slots:  RowSlots{Device: true, Project: true},
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
	require.NotContains(t, out, "setup importer\n\ntests")
	require.Contains(t, out, "id")
	require.Contains(t, out, "12345678-abcd-4ef0-9012-3456789abcde")
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

func TestFitProjectLabelDropsOwnerThenTruncatesLeft(t *testing.T) {
	t.Parallel()

	require.Equal(t, "c3-oss/prosa", fitProjectLabel("c3-oss/prosa", 20))
	require.Equal(t, "mz-operator-1", fitProjectLabel("mz-codes/mz-operator-1", 18))
	// Tail still too long → left truncation keeps the distinguishing end.
	require.Equal(t, "…rator-1", fitProjectLabel("mz-codes/mz-operator-1", 8))
}

func TestTimelineWidthsSizeToContent(t *testing.T) {
	t.Parallel()

	items := []TimelineItem{
		{Session: session.Session{Agent: "codex", DeviceID: "laptop", ProjectRemote: strp("git@github.com:mz-codes/mz-operator-1.git")}},
		{Session: session.Session{Agent: "claude-code", DeviceID: "tbox", ProjectRemote: strp("git@github.com:c3-oss/q.git")}},
	}
	w := timelineColumnWidths(items, TimelineOptions{
		Width: 120,
		Slots: RowSlots{Device: true, Project: true},
	})
	require.Equal(t, len("mz-codes/mz-operator-1"), w.project)
	require.Equal(t, len("laptop"), w.device)
	require.Equal(t, len("claude"), w.agent) // claude-code renders as "claude"
}

func TestTimelineWidthsShrinkDeviceBeforeProjectWhenNarrow(t *testing.T) {
	t.Parallel()

	labels := map[string]string{
		"d1": "ip-192-168-0-16-long",
		"d2": "another-long-device",
	}
	items := []TimelineItem{
		{Session: session.Session{Agent: "claude-code", DeviceID: "d1", ProjectRemote: strp("git@github.com:mz-codes/mz-operator-1.git")}},
		{Session: session.Session{Agent: "codex", DeviceID: "d2", ProjectRemote: strp("git@github.com:c3-oss/prosa.git")}},
	}
	wide := timelineColumnWidths(items, TimelineOptions{Width: 200, Slots: RowSlots{Device: true, Project: true}, DeviceLabels: labels})
	narrow := timelineColumnWidths(items, TimelineOptions{Width: 80, Slots: RowSlots{Device: true, Project: true}, DeviceLabels: labels})
	require.Less(t, narrow.device, wide.device, "device should shrink first on narrow terminals")
	require.LessOrEqual(t, narrow.project, wide.project)
}

func TestTimelineItemsShowsFullProjectWhenSpaceAllows(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.Local)
	item := TimelineItem{
		Session: session.Session{
			ID:             "s1",
			Agent:          "claude-code",
			DeviceID:       "laptop",
			ProjectRemote:  strp("git@github.com:mz-codes/mz-operator-1.git"),
			StartedAt:      now.Add(-10 * time.Minute),
			LastActivityAt: now.Add(-5 * time.Minute),
			FirstPrompt:    strp("refactor sync logic"),
		},
	}
	var b bytes.Buffer
	err := TimelineItems(&b, []TimelineItem{item}, now, TimelineOptions{
		Interactive: true,
		Width:       110,
		Layout:      TimelineGlobal,
		Slots:       RowSlots{Device: true, Project: true},
	})
	require.NoError(t, err)
	require.Contains(t, b.String(), "mz-codes/mz-operator-1",
		"project label must not be truncated when the row fits")
}
