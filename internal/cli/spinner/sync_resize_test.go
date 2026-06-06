package spinner

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/stretchr/testify/require"
)

// A WindowSizeMsg must update tracked width, and error detail lines must be
// truncated to that width rather than left for Bubble Tea to clip. See
// issue #78.
func TestSpinnerTracksWidthAndTruncatesErrors(t *testing.T) {
	m := newTestModel(1, false)

	mm, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 24})
	m = mm.(model)
	require.Equal(t, 40, m.width)

	longTail := strings.Repeat("x", 300)
	mm, _ = m.Update(Update{Phase: PhaseLocal, Index: 0, Err: errors.New("FOREIGN KEY constraint failed: " + longTail)})
	m = mm.(model)

	out := m.View()
	require.Contains(t, out, "…", "long error should be truncated with an ellipsis")
	require.NotContains(t, out, longTail, "full untruncated error must not be rendered")
}

// Before any resize, the budget falls back to defaultWidth so errors are
// still truncated deliberately instead of relying on the terminal.
func TestSpinnerErrBudgetFallsBackToDefault(t *testing.T) {
	m := newTestModel(1, false)
	require.Equal(t, defaultWidth-errMsgIndent, m.errMsgBudget())

	m.width = 200
	require.Equal(t, 200-errMsgIndent, m.errMsgBudget())

	m.width = 10 // narrower than the indent → floored
	require.Equal(t, 8, m.errMsgBudget())
}

func TestTruncateWidth(t *testing.T) {
	require.Equal(t, "", truncateWidth("anything", 0))
	require.Equal(t, "abc", truncateWidth("abc", 5))
	require.Equal(t, "abc", truncateWidth("abc", 3))
	require.Equal(t, "…", truncateWidth("abcdef", 1))
	require.Equal(t, "ab…", truncateWidth("abcdef", 3))
}
