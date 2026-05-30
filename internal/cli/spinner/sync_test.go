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

func newTestModel(total int) model {
	items := make([]Item, total)
	for i := range items {
		items[i] = Item{Agent: "claude-code", Path: "/tmp/whatever.jsonl"}
	}
	return model{
		items:     items,
		total:     total,
		activeIdx: -1,
		start:     time.Now().Add(-3 * time.Second),
	}
}

func TestFinishedQuitsAtCompletion(t *testing.T) {
	m := newTestModel(3)
	// Two done.
	for i := 0; i < 2; i++ {
		mm, _ := m.Update(Update{Index: i})
		m = mm.(model)
	}
	require.False(t, m.finished())
	require.Equal(t, 2, m.done)

	// Third hits errCount, total met.
	mm, cmd := m.Update(Update{Index: 2, Err: errors.New("boom")})
	m = mm.(model)
	require.True(t, m.finished())
	require.Equal(t, 1, m.errCount)
	require.NotNil(t, cmd, "should emit a tea.Quit cmd")

	got := cmd()
	// tea.Quit returns tea.QuitMsg.
	_, ok := got.(tea.QuitMsg)
	require.True(t, ok, "expected tea.QuitMsg, got %T", got)
}

func TestViewIsBoundedByErrorWindow(t *testing.T) {
	// 10 000 items: View() must remain O(K) regardless.
	m := newTestModel(10_000)
	// Stuff 50 errors; only the last maxErrorSlots should remain.
	for i := 0; i < 50; i++ {
		mm, _ := m.Update(Update{Index: i % 10_000, Err: errors.New("err")})
		m = mm.(model)
	}
	require.Len(t, m.errs, maxErrorSlots)

	out := m.View()
	// Sanity: contains progress line.
	require.Contains(t, out, "progress")
	require.Contains(t, out, "50 / 10000")
	// Way smaller than 10 000 * 80 ≈ 800 KB.
	require.Less(t, len(out), 8_000, "view should not scale with item count")
}

func TestStartedUpdateSetsCurrentWithoutIncrementing(t *testing.T) {
	m := newTestModel(2)
	mm, cmd := m.Update(Update{Index: 1, Started: true})
	m = mm.(model)

	require.Equal(t, 1, m.activeIdx)
	require.Equal(t, 0, m.done)
	require.Equal(t, 0, m.skipped)
	require.Equal(t, 0, m.errCount)
	require.NotNil(t, cmd)

	out := m.View()
	require.Contains(t, out, "current")
	require.Contains(t, out, "claude-code")
}

func TestActiveIndexBoundsCheck(t *testing.T) {
	m := newTestModel(2)
	// Negative or out-of-range Index must not panic.
	mm, _ := m.Update(Update{Index: -1, Skipped: true})
	m = mm.(model)
	require.Equal(t, 1, m.skipped)

	mm, _ = m.Update(Update{Index: 99, Skipped: true})
	m = mm.(model)
	require.Equal(t, 2, m.skipped)
}

func TestShortPathTrimsFromLeft(t *testing.T) {
	long := "/Users/abc/.local/share/prosa/raw/codex/2026/05/rollout-019e0995-fcdc-7f72-b926-08738a72af7b.jsonl"
	got := shortPath(long)
	// "…" is 3 bytes in UTF-8; allow that header on top of pathMax.
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
	// Run should leave progress visible in the normal scrollback. This
	// regression test guards the implementation note because Bubble Tea's
	// alt-screen option is not visible from model state.
	require.NotContains(t, sourceForTest(t), "tea.WithAltScreen")
}

func sourceForTest(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("sync.go")
	require.NoError(t, err)
	return string(data)
}
