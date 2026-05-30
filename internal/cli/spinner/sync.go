// Package spinner provides a Bubble Tea progress display for `prosa sync`.
// The view is compact and fixed-height regardless of how many sessions the
// run touches:
//
//   - One header line (command + banner).
//   - One progress line (counters + spinner + elapsed + eta).
//   - One "now active" line.
//   - Up to 5 persistent error blocks (rolling LRU).
//
// View() runs in O(K) where K = visible error slots — independent of N. This
// matters: a legacy bundle restore can produce 7 000+ work items, and an
// O(N) View() turned the terminal into 30 % CPU paint loops without
// progress (see ~/.claude/plans/leia-intent-md-e-inicie-keen-honey.md
// Commit 0 for the diagnosis).
//
// Callers outside an interactive TTY must NOT call Run — sync.go gates on
// cli.IsInteractive() and falls back to slog-linear output instead.
package spinner

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/c3-oss/prosa/internal/cli/render"
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

// Options tune the compact view's framing.
type Options struct {
	// Title prints on the very top line (defaults to "prosa sync").
	Title string
	// Banner is a free-form second line displayed under Title (legacy
	// bundle path, importer count, etc.). Optional.
	Banner string
}

const maxErrorSlots = 5

type errLine struct {
	agent string
	path  string
	msg   string
}

type model struct {
	items     []Item
	total     int
	done      int
	skipped   int
	errCount  int
	activeIdx int
	errs      []errLine // rolling LRU, len <= maxErrorSlots
	spin      spinner.Model
	ch        <-chan Update
	opts      Options
	start     time.Time
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

func (m model) finished() bool {
	return m.done+m.skipped+m.errCount >= m.total
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(v)
		return m, cmd
	case Update:
		if v.Index >= 0 && v.Index < len(m.items) {
			m.activeIdx = v.Index
		}
		switch {
		case v.Err != nil:
			m.errCount++
			it := m.items[v.Index]
			m.errs = append(m.errs, errLine{agent: it.Agent, path: it.Path, msg: v.Err.Error()})
			if len(m.errs) > maxErrorSlots {
				m.errs = m.errs[len(m.errs)-maxErrorSlots:]
			}
		case v.Skipped:
			m.skipped++
		default:
			m.done++
		}
		if m.finished() {
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
	styleHeader   = render.StyleHeader
	styleBanner   = render.StyleMuted
	styleSep      = render.StyleRail
	styleSpin     = render.StyleAccent
	styleDone     = render.StyleSuccess
	styleSkip     = render.StyleSkipped
	styleErr      = render.StyleError
	styleAgent    = render.StyleAgent
	styleProgress = render.StyleAccent
	styleTime     = render.StyleMuted
)

const pathMax = 70

func (m model) View() string {
	var b strings.Builder

	// Header + banner.
	title := m.opts.Title
	if title == "" {
		title = "prosa sync"
	}
	b.WriteString(" ")
	b.WriteString(styleHeader.Render(title))
	if m.opts.Banner != "" {
		b.WriteString("  ")
		b.WriteString(styleBanner.Render("•  " + m.opts.Banner))
	}
	b.WriteString("\n")
	b.WriteString(" ")
	b.WriteString(styleSep.Render(strings.Repeat("─", 72)))
	b.WriteString("\n")

	// Progress line.
	elapsed := time.Since(m.start)
	progress := fmt.Sprintf("[ %d / %d ]", m.done+m.skipped+m.errCount, m.total)
	stats := fmt.Sprintf(
		"%s %d   %s %d   %s %d",
		styleDone.Render("✓"), m.done,
		styleSkip.Render("↺"), m.skipped,
		styleErr.Render("✗"), m.errCount,
	)
	right := fmt.Sprintf(
		"%s   %s",
		styleTime.Render(humanDur(elapsed)),
		styleTime.Render("eta "+m.eta()),
	)
	fmt.Fprintf(&b,
		"   %s  %s   %s    %s\n",
		styleSpin.Render(m.spin.View()),
		styleProgress.Render(progress),
		stats,
		right,
	)

	// Active line.
	if !m.finished() && m.activeIdx >= 0 && m.activeIdx < len(m.items) {
		it := m.items[m.activeIdx]
		fmt.Fprintf(&b,
			"   %s  %s  %s\n",
			styleSep.Render("⤷"),
			styleAgent.Render(it.Agent),
			styleBanner.Render(shortPath(it.Path)),
		)
	}

	// Persistent errors.
	for _, e := range m.errs {
		b.WriteString("\n")
		fmt.Fprintf(&b,
			"   %s  %s   %s\n",
			styleErr.Render("✗"),
			styleAgent.Render(e.agent),
			styleBanner.Render(shortPath(e.path)),
		)
		fmt.Fprintf(&b, "      %s\n", styleErr.Render(e.msg))
	}

	return b.String()
}

func (m model) eta() string {
	completed := m.done + m.skipped + m.errCount
	if completed == 0 {
		return "—"
	}
	elapsed := time.Since(m.start)
	rate := float64(completed) / elapsed.Seconds()
	if rate <= 0 {
		return "—"
	}
	remaining := time.Duration(float64(m.total-completed) / rate * float64(time.Second)) // seconds
	if remaining < 0 {
		remaining = 0
	}
	return humanDur(remaining)
}

func humanDur(d time.Duration) string {
	if d < time.Second {
		return "0s"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		m := int(d.Minutes())
		s := int(d.Seconds()) - m*60
		return fmt.Sprintf("%dm%02ds", m, s)
	}
	h := int(d.Hours())
	m := int(d.Minutes()) - h*60
	return fmt.Sprintf("%dh%02dm", h, m)
}

// shortPath truncates a long path from the LEFT (keeps the tail, which is
// where the session id sits) and prefixes "…" so it's clear that prefix
// was dropped.
func shortPath(p string) string {
	if len(p) <= pathMax {
		return p
	}
	// Try to keep the last 2 path segments for context.
	keep := pathMax - 1
	tail := p[len(p)-keep:]
	// Cut at the next separator so we never break mid-segment.
	if i := strings.IndexAny(tail, "/"+string(filepath.Separator)); i >= 0 {
		tail = tail[i:]
	}
	return "…" + tail
}

// Run blocks until every item has produced an Update or the updates
// channel is closed. After Run returns, the alt-screen has been torn down
// and stdout is back to normal — the caller is free to print a summary.
func Run(ctx context.Context, items []Item, updates <-chan Update, opts Options) error {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	m := model{
		items:     items,
		total:     len(items),
		activeIdx: -1,
		spin:      sp,
		ch:        updates,
		opts:      opts,
		start:     time.Now(),
	}

	p := tea.NewProgram(m, tea.WithContext(ctx), tea.WithAltScreen())
	defer func() { _ = p.ReleaseTerminal() }()

	final, err := p.Run()
	if err != nil {
		return err
	}

	fm, ok := final.(model)
	if !ok {
		return nil
	}
	fmt.Printf("Imported %d, skipped %d, errors %d\n", fm.done, fm.skipped, fm.errCount)
	return nil
}
