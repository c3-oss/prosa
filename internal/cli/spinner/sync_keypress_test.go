package spinner

import (
	"io"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/stretchr/testify/require"
)

// Non-quit keystrokes during a run must not stop the spinner from
// consuming channel updates. If a key froze the channel read, the run
// below would never reach finished() and the program would hang. Keys are
// injected with p.Send so they deterministically route through Update's
// tea.KeyMsg branch. See issue #83.
func TestSpinnerKeepsConsumingAfterKeyPress(t *testing.T) {
	ch := make(chan Update, 16)
	sp := spinner.New()
	m := model{
		items:  []Item{{Agent: "claude-code", Path: "/x.jsonl"}},
		local:  defaultPhaseState("local"),
		remote: defaultPhaseState("remote"),
		spin:   sp,
		ch:     ch,
		opts:   Options{RemoteEnabled: false},
	}

	p := tea.NewProgram(m, tea.WithInput(nil), tea.WithOutput(io.Discard))

	type result struct {
		m   tea.Model
		err error
	}
	done := make(chan result, 1)
	go func() {
		fm, err := p.Run()
		done <- result{fm, err}
	}()

	key := func() { p.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}}) }

	// Interleave stray keypresses with each lifecycle step.
	key()
	ch <- Update{Phase: PhaseLocal, Begin: true, Total: 1, Verb: "importing"}
	key()
	ch <- Update{Phase: PhaseLocal, Index: 0, Started: true}
	key()
	ch <- Update{Phase: PhaseLocal, Index: 0} // per-item done
	key()
	ch <- Update{Phase: PhaseLocal, Done: true, Verb: "imported"}

	select {
	case r := <-done:
		require.NoError(t, r.err)
		fm := r.m.(model)
		require.Equal(t, 1, fm.local.done, "import update after keypress must be consumed")
		require.True(t, fm.local.finished)
	case <-time.After(5 * time.Second):
		p.Kill()
		t.Fatal("spinner froze after a keypress: channel updates were not consumed")
	}
}
