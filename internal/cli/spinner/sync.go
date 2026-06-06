// Package spinner provides a Bubble Tea progress display for `prosa sync`.
// The view is compact and fixed-height regardless of how many sessions the
// run touches:
//
//   - One header line (command + banner).
//   - One found-summary line when available.
//   - Two checklist rows (local import + optional remote catch-up).
//   - One "current" line for the active phase.
//   - Up to 5 persistent error blocks (rolling, preserving agent variety).
//
// View() runs in O(K) where K = visible error slots — independent of N.
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
	"github.com/charmbracelet/lipgloss"

	"github.com/c3-oss/prosa/internal/cli/render"
)

var nowFn = time.Now

// Phase identifies which sync stage an Update applies to.
type Phase int

const (
	PhaseLocal Phase = iota
	PhaseRemote
)

// Item describes one session about to be imported or reconciled.
type Item struct {
	Agent string
	Path  string
}

// Update is produced by the sync driver goroutine for lifecycle events and
// per-item progress.
type Update struct {
	Phase Phase

	// Phase lifecycle.
	Begin       bool
	Total       int
	Verb        string
	SetTotal    bool
	Done        bool
	Extra       string
	Unavailable bool

	// Per-item progress (local import index or remote step completion).
	Index   int
	Started bool
	Skipped bool
	Err     error

	// Active sets the current line for the given phase without bumping counters.
	Active *Item
}

// Options tune the compact view's framing.
type Options struct {
	// Title prints on the very top line (defaults to "prosa sync · local store").
	Title string
	// Banner is a free-form fragment displayed after Title (legacy bundle path).
	Banner string
	// Found summarizes discovered work per agent. Optional.
	Found string
	// RemoteEnabled shows the remote catch-up row and waits for it before quit.
	RemoteEnabled bool
}

const maxErrorSlots = 5

type errLine struct {
	agent string
	path  string
	msg   string
}

type phaseState struct {
	label       string
	verb        string
	total       int
	done        int
	skipped     int
	errCount    int
	started     bool
	finished    bool
	unavailable bool
	determinate bool
	start       time.Time
	elapsed     time.Duration
	extra       string
}

type model struct {
	items       []Item
	local       phaseState
	remote      phaseState
	active      *Item
	activePhase Phase
	errs        []errLine
	errHidden   int
	spin        spinner.Model
	ch          <-chan Update
	opts        Options
	// width is the current terminal width from the latest WindowSizeMsg.
	// 0 until the first resize event; renderers fall back to defaultWidth.
	width int
}

// defaultWidth is the assumed terminal width before the first
// WindowSizeMsg (and a floor so error lines stay readable on tiny TTYs).
const defaultWidth = 80

// errMsgIndent is the left padding (in columns) of the error-detail line in
// View; the truncation budget is the terminal width minus this.
const errMsgIndent = 15

func defaultPhaseState(label string) phaseState {
	return phaseState{label: label}
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

func (m *model) phaseFor(p Phase) *phaseState {
	if p == PhaseRemote {
		return &m.remote
	}
	return &m.local
}

func (m model) finished() bool {
	if !m.local.finished {
		return false
	}
	if !m.opts.RemoteEnabled {
		return true
	}
	return m.remote.finished
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(v)
		return m, cmd
	case Update:
		ps := m.phaseFor(v.Phase)
		if v.Begin {
			ps.started = true
			ps.determinate = v.Total > 0
			ps.total = v.Total
			if v.Verb != "" {
				ps.verb = v.Verb
			}
			ps.start = nowFn()
			m.activePhase = v.Phase
			return m, recvCmd(m.ch)
		}
		if v.SetTotal {
			ps.total = v.Total
			ps.determinate = true
			return m, recvCmd(m.ch)
		}
		if v.Started {
			if v.Index >= 0 && v.Index < len(m.items) {
				it := m.items[v.Index]
				m.active = &it
				m.activePhase = v.Phase
			}
			return m, recvCmd(m.ch)
		}
		if v.Active != nil {
			m.active = v.Active
			m.activePhase = v.Phase
		}
		if v.Done {
			ps.finished = true
			ps.unavailable = v.Unavailable
			ps.extra = v.Extra
			if !ps.start.IsZero() {
				ps.elapsed = nowFn().Sub(ps.start)
			}
			if v.Unavailable {
				if ps.verb == "" {
					ps.verb = "unavailable"
				}
			} else if v.Verb != "" {
				ps.verb = v.Verb
			} else if v.Phase == PhaseLocal {
				ps.verb = "imported"
			} else {
				ps.verb = "sent"
			}
			m.active = nil
			if m.finished() {
				return m, tea.Quit
			}
			return m, recvCmd(m.ch)
		}
		// Per-item completion.
		switch {
		case v.Err != nil:
			ps.errCount++
			if v.Phase == PhaseLocal && v.Index >= 0 && v.Index < len(m.items) {
				it := m.items[v.Index]
				m.recordError(errLine{agent: it.Agent, path: it.Path, msg: v.Err.Error()})
			} else if v.Active != nil {
				m.recordError(errLine{agent: v.Active.Agent, path: v.Active.Path, msg: v.Err.Error()})
			}
		case v.Skipped:
			ps.skipped++
		default:
			ps.done++
		}
		if m.finished() {
			return m, tea.Quit
		}
		return m, recvCmd(m.ch)
	case tea.WindowSizeMsg:
		m.width = v.Width
		return m, nil
	case closedMsg:
		return m, tea.Quit
	case tea.KeyMsg:
		if v.String() == "ctrl+c" || v.String() == "q" {
			return m, tea.Quit
		}
	}
	// Non-Update messages (key presses, resize, stray ticks) fall through
	// here. They must NOT return recvCmd: the channel read is re-armed by
	// every `case Update` branch, so exactly one recvCmd is always in
	// flight. Spawning another from a key press would leak a blocked reader
	// goroutine per keystroke. TestSpinnerKeepsConsumingAfterKeyPress guards
	// that updates keep flowing across keystrokes.
	return m, nil
}

func (m *model) recordError(line errLine) {
	m.errs = append(m.errs, line)
	for len(m.errs) > maxErrorSlots {
		m.evictError()
	}
}

func (m *model) evictError() {
	counts := make(map[string]int, len(m.errs))
	for _, e := range m.errs {
		counts[e.agent]++
	}
	drop := 0
	for i, e := range m.errs {
		if counts[e.agent] > 1 {
			drop = i
			break
		}
	}
	m.errs = append(m.errs[:drop], m.errs[drop+1:]...)
	m.errHidden++
}

func (ps phaseState) finishedCount() int {
	return ps.done + ps.skipped + ps.errCount
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
	stylePending  = render.StyleMuted
)

const pathMax = 70

func (m model) View() string {
	var b strings.Builder

	title := m.opts.Title
	if title == "" {
		title = "prosa sync · local store"
	}
	b.WriteString(styleHeader.Render(title))
	if m.opts.Banner != "" {
		b.WriteString(styleBanner.Render(" · " + m.opts.Banner))
	}
	b.WriteString("\n")
	b.WriteString(styleSep.Render(strings.Repeat("─", 72)))
	b.WriteString("\n")

	if m.opts.Found != "" {
		fmt.Fprintf(&b, "%s          %s\n", styleBanner.Render("found"), m.opts.Found)
	}
	b.WriteString("\n")

	m.writePhaseRow(&b, &m.local, "imported")
	if m.opts.RemoteEnabled {
		m.writePhaseRow(&b, &m.remote, "sent")
	}

	if m.active != nil && !m.phaseFor(m.activePhase).finished {
		fmt.Fprintf(
			&b,
			"%s        %s · %s\n",
			styleBanner.Render("current"),
			styleAgent.Render(m.active.Agent),
			styleBanner.Render(shortPath(m.active.Path)),
		)
	}

	if len(m.errs) > 0 {
		b.WriteString("\n")
		b.WriteString(styleErr.Render("errors"))
		b.WriteString("\n")
	}
	if m.errHidden > 0 {
		fmt.Fprintf(&b, "  %s\n", styleBanner.Render(fmt.Sprintf("+%d earlier errors hidden", m.errHidden)))
	}
	for _, e := range m.errs {
		fmt.Fprintf(
			&b,
			"  %s       %s\n",
			styleAgent.Render(e.agent),
			styleBanner.Render(shortPath(e.path)),
		)
		fmt.Fprintf(&b, "               %s\n", styleErr.Render(truncateWidth(e.msg, m.errMsgBudget())))
	}

	return b.String()
}

// errMsgBudget is the column width available for an error-detail line,
// derived from the current terminal width (or defaultWidth before the
// first resize) minus the line's left indent. Floored so a narrow TTY
// still shows a couple of characters plus the ellipsis.
func (m model) errMsgBudget() int {
	w := m.width
	if w <= 0 {
		w = defaultWidth
	}
	budget := w - errMsgIndent
	if budget < 8 {
		budget = 8
	}
	return budget
}

// truncateWidth clips s to at most n display columns, appending "…" when it
// has to cut. Width-aware so wide runes are accounted for. Mirrors
// render.truncateWidth; kept local to avoid widening that package's API.
func truncateWidth(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	var b strings.Builder
	limit := n - 1
	for _, r := range s {
		next := string(r)
		if lipgloss.Width(b.String())+lipgloss.Width(next) > limit {
			break
		}
		b.WriteRune(r)
	}
	return b.String() + "…"
}

func (m model) writePhaseRow(b *strings.Builder, ps *phaseState, doneLabel string) {
	glyph := m.phaseGlyph(ps)
	var elapsed time.Duration
	switch {
	case ps.finished:
		elapsed = ps.elapsed
	case ps.started && !ps.start.IsZero():
		elapsed = nowFn().Sub(ps.start)
	}

	var progress string
	if ps.finished {
		if ps.unavailable {
			progress = fmt.Sprintf(
				"%s · %s %d · %s %d · %s %d",
				styleProgress.Render(ps.verb),
				styleDone.Render(doneLabel), ps.done,
				styleSkip.Render("skipped"), ps.skipped,
				styleErr.Render("errors"), ps.errCount,
			)
		} else {
			progress = styleTime.Render(humanDur(elapsed))
		}
		if ps.extra != "" {
			progress += " · " + styleBanner.Render(ps.extra)
		}
	} else if ps.started {
		var parts strings.Builder
		fmt.Fprintf(&parts, "%s  ", styleProgress.Render(ps.verb))
		if ps.determinate && ps.total > 0 {
			fmt.Fprintf(&parts, "%d / %d · ", ps.finishedCount(), ps.total)
		}
		fmt.Fprintf(
			&parts,
			"%s %d · %s %d · %s %d · %s",
			styleDone.Render(doneLabel), ps.done,
			styleSkip.Render("skipped"), ps.skipped,
			styleErr.Render("errors"), ps.errCount,
			styleTime.Render(humanDur(elapsed)),
		)
		if ps.determinate && ps.total > 0 {
			fmt.Fprintf(&parts, " · %s", styleTime.Render("eta "+phaseETA(ps)))
		}
		progress = parts.String()
	} else {
		progress = stylePending.Render("pending")
	}

	fmt.Fprintf(b, "%s %-13s%s\n", glyph, ps.label, progress)
}

func (m model) phaseGlyph(ps *phaseState) string {
	switch {
	case ps.finished && ps.unavailable:
		return styleErr.Render("✗")
	case ps.finished:
		return styleDone.Render("✓")
	case ps.started:
		return styleSpin.Render("→")
	default:
		return stylePending.Render("·")
	}
}

func phaseETA(ps *phaseState) string {
	completed := ps.finishedCount()
	if completed == 0 || ps.total <= 0 {
		return "—"
	}
	elapsed := nowFn().Sub(ps.start)
	rate := float64(completed) / elapsed.Seconds()
	if rate <= 0 {
		return "—"
	}
	remaining := time.Duration(float64(ps.total-completed) / rate * float64(time.Second))
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
	keep := pathMax - 1
	tail := p[len(p)-keep:]
	if i := strings.IndexAny(tail, "/"+string(filepath.Separator)); i >= 0 {
		tail = tail[i:]
	}
	return "…" + tail
}

// Run blocks until every phase has finished or the updates channel is closed.
// It does not use the alternate screen, so the user can still see the final
// progress frame above the caller's summary.
func Run(ctx context.Context, items []Item, updates <-chan Update, opts Options) error {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	m := model{
		items:  items,
		local:  defaultPhaseState("local"),
		remote: defaultPhaseState("remote"),
		spin:   sp,
		ch:     updates,
		opts:   opts,
	}

	p := tea.NewProgram(m, tea.WithContext(ctx))
	defer func() { _ = p.ReleaseTerminal() }()

	if _, err := p.Run(); err != nil {
		return err
	}
	return nil
}
