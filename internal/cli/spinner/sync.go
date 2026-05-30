// Package spinner provides a Bubble Tea progress display for `prosa sync`.
// One line per session being imported, with a spinner while pending and a
// terminal glyph + status text once the importer reports back. Callers
// outside an interactive TTY must NOT call Run — sync.go gates on
// cli.IsInteractive() and falls back to slog-linear output instead.
package spinner

import (
	"context"
	"fmt"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Item describes one session about to be imported. Index in the slice
// passed to Run is the stable identifier matched against Update.Index.
type Item struct {
	Agent string
	Path  string
}

// Update is produced by the importer goroutine for each completed session.
type Update struct {
	Index   int
	Skipped bool
	Err     error
}

type status int

const (
	statusPending status = iota
	statusDone
	statusSkipped
	statusError
)

type model struct {
	items     []Item
	statuses  []status
	errs      []string
	spin      spinner.Model
	ch        <-chan Update
	doneCount int
}

type closedMsg struct{}

func recvCmd(ch <-chan Update) tea.Cmd {
	return func() tea.Msg {
		u, ok := <-ch
		if !ok {
			return closedMsg{}
		}
		return u
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(m.spin.Tick, recvCmd(m.ch))
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(v)
		return m, cmd
	case Update:
		if v.Index >= 0 && v.Index < len(m.statuses) {
			switch {
			case v.Err != nil:
				m.statuses[v.Index] = statusError
				m.errs[v.Index] = v.Err.Error()
			case v.Skipped:
				m.statuses[v.Index] = statusSkipped
			default:
				m.statuses[v.Index] = statusDone
			}
		}
		m.doneCount++
		if m.doneCount >= len(m.items) {
			return m, tea.Quit
		}
		return m, recvCmd(m.ch)
	case closedMsg:
		return m, tea.Quit
	case tea.KeyMsg:
		if v.String() == "ctrl+c" || v.String() == "q" {
			return m, tea.Quit
		}
	}
	return m, nil
}

var (
	stylePending = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	styleDone    = lipgloss.NewStyle().Foreground(lipgloss.Color("46"))
	styleSkipped = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	styleErr     = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	styleAgent   = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
)

func (m model) View() string {
	var out string
	for i, it := range m.items {
		var prefix, status string
		switch m.statuses[i] {
		case statusPending:
			prefix = stylePending.Render(m.spin.View())
			status = "importing..."
		case statusDone:
			prefix = styleDone.Render("✓")
			status = "done"
		case statusSkipped:
			prefix = styleSkipped.Render("·")
			status = "skipped"
		case statusError:
			prefix = styleErr.Render("✗")
			status = "error: " + m.errs[i]
		}
		out += fmt.Sprintf(
			" %s  %s  %s  %s\n",
			prefix,
			styleAgent.Render(it.Agent),
			shortPath(it.Path),
			status,
		)
	}
	return out
}

func shortPath(p string) string {
	const max = 60
	if len(p) <= max {
		return p
	}
	return "…" + p[len(p)-(max-1):]
}

// Run blocks until every item has produced an Update or the updates
// channel is closed. The Bubble Tea program registers a SIGTERM/SIGINT
// handler itself; we add defer p.ReleaseTerminal() as panic-safety against
// importer goroutines crashing mid-line.
//
// After Run returns, the alt-screen has been torn down and stdout is back
// to normal — the caller is free to print a summary line.
func Run(ctx context.Context, items []Item, updates <-chan Update) error {
	statuses := make([]status, len(items))
	errs := make([]string, len(items))
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	m := model{
		items:    items,
		statuses: statuses,
		errs:     errs,
		spin:     sp,
		ch:       updates,
	}

	p := tea.NewProgram(m, tea.WithContext(ctx))
	defer func() { _ = p.ReleaseTerminal() }()

	final, err := p.Run()
	if err != nil {
		return err
	}

	fm, ok := final.(model)
	if !ok {
		return nil
	}
	var imp, skp, errsCount int
	for _, s := range fm.statuses {
		switch s {
		case statusError:
			errsCount++
		case statusSkipped:
			skp++
		case statusDone:
			imp++
		}
	}
	fmt.Printf("Imported %d, skipped %d, errors %d\n", imp, skp, errsCount)
	return nil
}
