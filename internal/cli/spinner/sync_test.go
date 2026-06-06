package spinner

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/stretchr/testify/require"
)

func newTestModel(total int, remote bool) model {
	items := make([]Item, total)
	for i := range items {
		items[i] = Item{Agent: "claude-code", Path: "/tmp/whatever.jsonl"}
	}
	m := model{
		items:  items,
		local:  defaultPhaseState("local"),
		remote: defaultPhaseState("remote"),
		opts:   Options{RemoteEnabled: remote},
	}
	m.local.start = nowFn().Add(-3 * time.Second)
	return m
}

func fixedNow(t *testing.T) time.Time {
	t.Helper()
	now := time.Date(2026, 6, 6, 12, 0, 0, 0, time.UTC)
	prev := nowFn
	nowFn = func() time.Time { return now }
	t.Cleanup(func() { nowFn = prev })
	return now
}

func beginLocal(m model, total int) model {
	mm, _ := m.Update(Update{Phase: PhaseLocal, Begin: true, Total: total, Verb: "importing"})
	return mm.(model)
}

func TestFinishedQuitsWhenLocalDoneWithoutRemote(t *testing.T) {
	m := beginLocal(newTestModel(3, false), 3)
	for i := 0; i < 2; i++ {
		mm, _ := m.Update(Update{Phase: PhaseLocal, Index: i})
		m = mm.(model)
	}
	require.False(t, m.finished())

	mm, _ := m.Update(Update{Phase: PhaseLocal, Index: 2, Err: errors.New("boom")})
	m = mm.(model)
	require.False(t, m.finished())

	mm, cmd := m.Update(Update{Phase: PhaseLocal, Done: true, Verb: "imported"})
	m = mm.(model)
	require.True(t, m.finished())
	require.NotNil(t, cmd)
	_, ok := cmd().(tea.QuitMsg)
	require.True(t, ok)
}

func TestFinishedWaitsForRemoteWhenEnabled(t *testing.T) {
	m := beginLocal(newTestModel(1, true), 1)
	mm, _ := m.Update(Update{Phase: PhaseLocal, Index: 0})
	m = mm.(model)
	mm, _ = m.Update(Update{Phase: PhaseLocal, Done: true, Verb: "imported"})
	m = mm.(model)
	require.False(t, m.finished())

	mm, _ = m.Update(Update{Phase: PhaseRemote, Begin: true, Verb: "reconciling"})
	m = mm.(model)
	mm, _ = m.Update(Update{Phase: PhaseRemote, SetTotal: true, Total: 1})
	m = mm.(model)
	mm, _ = m.Update(Update{Phase: PhaseRemote, Active: &Item{Path: "sess-1"}})
	m = mm.(model)
	require.False(t, m.finished())

	mm, cmd := m.Update(Update{Phase: PhaseRemote, Done: true, Verb: "sent"})
	m = mm.(model)
	require.True(t, m.finished())
	require.NotNil(t, cmd)
}

func TestViewIsBoundedByErrorWindow(t *testing.T) {
	m := beginLocal(newTestModel(10_000, false), 10_000)
	for i := 0; i < 50; i++ {
		mm, _ := m.Update(Update{Phase: PhaseLocal, Index: i % 10_000, Err: errors.New("err")})
		m = mm.(model)
	}
	require.Len(t, m.errs, maxErrorSlots)
	require.Equal(t, 45, m.errHidden)

	out := m.View()
	require.Contains(t, out, "local")
	require.Contains(t, out, "errors")
	require.Contains(t, out, "+45 earlier errors hidden")
	require.Less(t, len(out), 8_000, "view should not scale with item count")
}

func TestErrorWindowPreservesAgentLabelsWhenEvicting(t *testing.T) {
	m := beginLocal(newTestModel(20, false), 20)
	m.items[0].Agent = "cursor"
	for i := 1; i < len(m.items); i++ {
		m.items[i].Agent = "claude-code"
	}

	mm, _ := m.Update(Update{Phase: PhaseLocal, Index: 0, Err: errors.New("cursor failed")})
	m = mm.(model)
	for i := 1; i <= maxErrorSlots+2; i++ {
		mm, _ = m.Update(Update{Phase: PhaseLocal, Index: i, Err: errors.New("claude failed")})
		m = mm.(model)
	}

	require.Len(t, m.errs, maxErrorSlots)
	require.Equal(t, maxErrorSlots+3-len(m.errs), m.errHidden)
	var agents []string
	for _, e := range m.errs {
		agents = append(agents, e.agent)
	}
	require.Contains(t, agents, "cursor")
	require.Contains(t, agents, "claude-code")

	out := m.View()
	require.Contains(t, out, "cursor")
	require.Contains(t, out, "claude-code")
	require.Contains(t, out, "earlier errors hidden")
}

func TestStartedUpdateSetsCurrentWithoutIncrementing(t *testing.T) {
	m := beginLocal(newTestModel(2, false), 2)
	mm, cmd := m.Update(Update{Phase: PhaseLocal, Index: 1, Started: true})
	m = mm.(model)

	require.NotNil(t, m.active)
	require.Equal(t, "claude-code", m.active.Agent)
	require.Equal(t, 0, m.local.done)
	require.Equal(t, 0, m.local.skipped)
	require.Equal(t, 0, m.local.errCount)
	require.NotNil(t, cmd)

	out := m.View()
	require.Contains(t, out, "current")
	require.Contains(t, out, "claude-code")
	require.Equal(t, 1, strings.Count(out, "whatever.jsonl"))
}

func TestCompletedRowRendersCheckWithoutSpinnerGlyph(t *testing.T) {
	m := beginLocal(newTestModel(1, true), 1)
	mm, _ := m.Update(Update{Phase: PhaseLocal, Index: 0})
	m = mm.(model)
	mm, _ = m.Update(Update{Phase: PhaseLocal, Done: true, Verb: "imported"})
	m = mm.(model)

	out := m.View()
	require.Contains(t, out, "✓")
	require.NotContains(t, out, "⣾")
	require.NotContains(t, out, "⣽")
}

func TestFinishedRowNoCounters(t *testing.T) {
	now := fixedNow(t)
	m := beginLocal(newTestModel(1, false), 1)
	m.local.start = now.Add(-17 * time.Second)
	m.local.done = 27
	m.local.skipped = 1882

	mm, _ := m.Update(Update{Phase: PhaseLocal, Done: true, Verb: "imported"})
	m = mm.(model)

	out := m.View()
	require.Contains(t, out, "17s")
	require.NotContains(t, out, "skipped")
	require.NotContains(t, out, "imported 27")
}

func TestFinishedRowIsCompact(t *testing.T) {
	now := fixedNow(t)
	m := beginLocal(newTestModel(1, true), 1)
	m.local.start = now.Add(-5 * time.Second)
	mm, _ := m.Update(Update{Phase: PhaseLocal, Done: true, Verb: "imported"})
	m = mm.(model)

	out := m.View()
	require.Contains(t, out, "✓")
	require.Contains(t, out, "5s")
	require.NotContains(t, out, "errors")
}

func TestFrozenElapsedAtCompletion(t *testing.T) {
	now := fixedNow(t)
	m := beginLocal(newTestModel(1, true), 1)
	m.local.start = now.Add(-16 * time.Second)

	mm, _ := m.Update(Update{Phase: PhaseLocal, Done: true, Verb: "imported"})
	m = mm.(model)
	require.GreaterOrEqual(t, m.local.elapsed, 15*time.Second)

	out1 := m.View()
	require.Contains(t, out1, "16s")

	time.Sleep(50 * time.Millisecond)
	out2 := m.View()
	require.Equal(t, out1, out2, "finished row elapsed must not tick after Done")
}

func TestRemoteRowHiddenWhenDisabled(t *testing.T) {
	m := beginLocal(newTestModel(1, false), 1)
	out := m.View()
	require.Contains(t, out, "local")
	require.NotContains(t, out, "remote")
}

func TestActiveIndexBoundsCheck(t *testing.T) {
	m := beginLocal(newTestModel(2, false), 2)
	mm, _ := m.Update(Update{Phase: PhaseLocal, Index: -1, Skipped: true})
	m = mm.(model)
	require.Equal(t, 1, m.local.skipped)

	mm, _ = m.Update(Update{Phase: PhaseLocal, Index: 99, Skipped: true})
	m = mm.(model)
	require.Equal(t, 2, m.local.skipped)
}

func TestShortPathTrimsFromLeft(t *testing.T) {
	long := "/Users/abc/.local/share/prosa/raw/codex/2026/05/rollout-019e0995-fcdc-7f72-b926-08738a72af7b.jsonl"
	got := shortPath(long)
	require.LessOrEqual(t, len(got), pathMax+3)
	require.True(t, strings.HasPrefix(got, "…"))
	require.True(t, strings.HasSuffix(got, ".jsonl"))
}

func TestHumanDur(t *testing.T) {
	require.Equal(t, "0s", humanDur(0))
	require.Equal(t, "45s", humanDur(45*time.Second))
	require.Equal(t, "1m05s", humanDur(65*time.Second))
	require.Equal(t, "1h02m", humanDur(3720*time.Second))
}

func TestRunDoesNotUseAltScreen(t *testing.T) {
	require.NotContains(t, sourceForTest(t), "tea.WithAltScreen")
}

func sourceForTest(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("sync.go")
	require.NoError(t, err)
	return string(data)
}
