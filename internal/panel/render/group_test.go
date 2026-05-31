package render

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestGroupTurnsEmpty(t *testing.T) {
	require.Empty(t, GroupTurns(nil))
	require.Empty(t, GroupTurns([]Turn{}))
}

func TestGroupTurnsAllSingles(t *testing.T) {
	in := []Turn{
		{Role: "user"},
		{Role: "assistant"},
		{Role: "user"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 3)
	for i, g := range got {
		require.Equal(t, "single", g.Kind, "row %d", i)
	}
}

func TestGroupTurnsAllToolsCoalesce(t *testing.T) {
	in := []Turn{
		{Role: "tool", ToolName: "Read"},
		{Role: "tool", ToolName: "Read"},
		{Role: "tool", ToolName: "Bash"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 1)
	require.Equal(t, "tool-group", got[0].Kind)
	require.Len(t, got[0].Tools, 3)
	require.Equal(t, "Read ×2 · Bash ×1", got[0].Summary)
}

func TestGroupTurnsSingleToolRunBecomesGroupOfOne(t *testing.T) {
	in := []Turn{{Role: "tool", ToolName: "WebFetch"}}
	got := GroupTurns(in)
	require.Len(t, got, 1)
	require.Equal(t, "tool-group", got[0].Kind)
	require.Len(t, got[0].Tools, 1)
	require.Equal(t, "WebFetch ×1", got[0].Summary)
}

func TestGroupTurnsAlternating(t *testing.T) {
	in := []Turn{
		{Role: "user"},
		{Role: "assistant"},
		{Role: "tool", ToolName: "Read"},
		{Role: "tool", ToolName: "Read"},
		{Role: "assistant"},
		{Role: "tool", ToolName: "Bash"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 5)
	require.Equal(t, "single", got[0].Kind)
	require.Equal(t, "single", got[1].Kind)
	require.Equal(t, "tool-group", got[2].Kind)
	require.Len(t, got[2].Tools, 2)
	require.Equal(t, "Read ×2", got[2].Summary)
	require.Equal(t, "single", got[3].Kind)
	require.Equal(t, "tool-group", got[4].Kind)
	require.Len(t, got[4].Tools, 1)
}

func TestGroupTurnsSummaryOrdersByCountDescThenNameAsc(t *testing.T) {
	in := []Turn{
		{Role: "tool", ToolName: "Edit"},
		{Role: "tool", ToolName: "Bash"},
		{Role: "tool", ToolName: "Bash"},
		{Role: "tool", ToolName: "Bash"},
		{Role: "tool", ToolName: "Read"},
		{Role: "tool", ToolName: "Read"},
		{Role: "tool", ToolName: "Edit"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 1)
	// Counts: Bash 3, Read 2, Edit 2. Bash first by count, then
	// Edit/Read tied at 2 with Edit < Read alphabetically.
	require.Equal(t, "Bash ×3 · Edit ×2 · Read ×2", got[0].Summary)
}

func TestGroupTurnsHandlesEmptyToolName(t *testing.T) {
	in := []Turn{
		{Role: "tool", ToolName: ""},
		{Role: "tool", ToolName: ""},
		{Role: "tool", ToolName: "Read"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 1)
	require.Equal(t, "tool ×2 · Read ×1", got[0].Summary)
}

func TestGroupTurnsCoalescesThinking(t *testing.T) {
	in := []Turn{
		{Role: "user"},
		{Role: "assistant", Kind: "thinking", Body: "step 1"},
		{Role: "assistant", Kind: "thinking", Body: "step 2"},
		{Role: "assistant", Kind: "thinking", Body: "step 3"},
		{Role: "assistant", Kind: "message", Body: "the answer"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 3)
	require.Equal(t, "single", got[0].Kind)
	require.Equal(t, "thinking-group", got[1].Kind)
	require.Len(t, got[1].Tools, 3)
	require.Equal(t, "Processed (3 steps)", got[1].Summary)
	require.Equal(t, "single", got[2].Kind)
}

func TestGroupTurnsThinkingSingleStepCompactLabel(t *testing.T) {
	in := []Turn{
		{Role: "assistant", Kind: "thinking", Body: "one short thought"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 1)
	require.Equal(t, "thinking-group", got[0].Kind)
	require.Equal(t, "Processed", got[0].Summary)
}

func TestGroupTurnsThinkingDoesNotMergeWithTools(t *testing.T) {
	in := []Turn{
		{Role: "assistant", Kind: "thinking"},
		{Role: "tool", ToolName: "Read"},
		{Role: "assistant", Kind: "thinking"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 3, "thinking and tool runs must each get their own group")
	require.Equal(t, "thinking-group", got[0].Kind)
	require.Equal(t, "tool-group", got[1].Kind)
	require.Equal(t, "thinking-group", got[2].Kind)
}

func TestGroupTurnsInsertsDividerOnLongGap(t *testing.T) {
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	in := []Turn{
		{Role: "user", Ts: base},
		{Role: "assistant", Ts: base.Add(2 * time.Second)},
		// 2-minute gap → divider expected.
		{Role: "user", Ts: base.Add(2 * time.Minute)},
		{Role: "assistant", Ts: base.Add(2*time.Minute + 5*time.Second)},
	}
	got := GroupTurns(in)
	require.Len(t, got, 5)
	require.Equal(t, "single", got[0].Kind)
	require.Equal(t, "single", got[1].Kind)
	require.Equal(t, "divider", got[2].Kind)
	require.Contains(t, got[2].Summary, "Worked for")
	require.Equal(t, "single", got[3].Kind)
	require.Equal(t, "single", got[4].Kind)
}

func TestGroupTurnsNoDividerBelowThreshold(t *testing.T) {
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	in := []Turn{
		{Role: "user", Ts: base},
		{Role: "assistant", Ts: base.Add(5 * time.Second)},
		{Role: "user", Ts: base.Add(20 * time.Second)},
	}
	got := GroupTurns(in)
	require.Len(t, got, 3, "no divider when all gaps are below DividerThreshold")
	for _, g := range got {
		require.NotEqual(t, "divider", g.Kind)
	}
}

func TestGroupTurnsNoDividerForZeroTimestamps(t *testing.T) {
	// Test inputs without Ts (the fixtures used by the older tests in
	// this file) must not synthesize dividers — the gap is undefined.
	in := []Turn{{Role: "user"}, {Role: "assistant"}, {Role: "user"}}
	got := GroupTurns(in)
	require.Len(t, got, 3)
	for _, g := range got {
		require.NotEqual(t, "divider", g.Kind)
	}
}

func TestGroupTurnsDividerSitsAfterPendingGroups(t *testing.T) {
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	in := []Turn{
		{Role: "tool", ToolName: "Read", Ts: base},
		{Role: "tool", ToolName: "Read", Ts: base.Add(time.Second)},
		// 90s gap → divider must appear AFTER the tool-group, not
		// inside it.
		{Role: "user", Ts: base.Add(90 * time.Second)},
	}
	got := GroupTurns(in)
	require.Len(t, got, 3)
	require.Equal(t, "tool-group", got[0].Kind)
	require.Equal(t, "divider", got[1].Kind)
	require.Equal(t, "single", got[2].Kind)
}

func TestGroupTurnsPreservesOrderWithinTools(t *testing.T) {
	in := []Turn{
		{Role: "tool", ToolName: "Read", Body: "a"},
		{Role: "tool", ToolName: "Read", Body: "b"},
		{Role: "tool", ToolName: "Read", Body: "c"},
	}
	got := GroupTurns(in)
	require.Len(t, got, 1)
	require.Equal(t, "a", string(got[0].Tools[0].Body))
	require.Equal(t, "b", string(got[0].Tools[1].Body))
	require.Equal(t, "c", string(got[0].Tools[2].Body))
}
