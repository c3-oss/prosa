// Package render formats the prosa timeline for both interactive
// terminals (Lipgloss colors, day-grouped headers, active markers) and
// non-interactive sinks (pipes/redirects/scripts — plain tab-separated
// rows without escape codes).
package render

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"github.com/c3-oss/prosa/pkg/session"
)

// Prompt text is the row's payload; it absorbs whatever width the
// metadata columns leave over, between these bounds. The cap keeps
// very wide terminals from stretching rows past a comfortable measure.
const (
	promptMinWidth = 24
	promptMaxWidth = 96
)

type TimelineLayout int

const (
	TimelineScoped TimelineLayout = iota
	TimelineGlobal
)

type TimelineItem struct {
	Session session.Session
	Tools   []session.ToolUsage
}

type TimelineOptions struct {
	Interactive bool
	Width       int
	Layout      TimelineLayout
	// Slots controls scope-aware column suppression. Callers must set
	// this explicitly (via ResolveSlots); leaving it zero means
	// "render no device, no project" — which is intentional but rare,
	// so the convenience wrapper Timeline() always passes both true
	// for backward compatibility.
	Slots RowSlots
	// DeviceLabels maps device_id → friendly_name; the row uses it via
	// DeviceLabel(...) so the column shows "Studio M4" instead of the
	// raw hex fingerprint. Nil is OK — the fallback handles it.
	DeviceLabels map[string]string
}

// Timeline writes sessions to w grouped by day with Lipgloss colors when
// interactive == true, or as plain tab-separated lines otherwise.
func Timeline(w io.Writer, sessions []session.Session, now time.Time, interactive bool) error {
	items := make([]TimelineItem, len(sessions))
	for i := range sessions {
		items[i] = TimelineItem{Session: sessions[i]}
	}
	return TimelineItems(w, items, now, TimelineOptions{
		Interactive: interactive,
		Width:       80,
		Layout:      TimelineScoped,
		Slots:       RowSlots{Device: true, Project: true},
	})
}

func TimelineItems(w io.Writer, items []TimelineItem, now time.Time, opts TimelineOptions) error {
	if !opts.Interactive {
		sessions := make([]session.Session, len(items))
		for i := range items {
			sessions[i] = items[i].Session
		}
		return timelinePlain(w, sessions)
	}
	if opts.Width <= 0 {
		opts.Width = 80
	}
	widths := timelineColumnWidths(items, opts)

	var lastHeader string
	for i, item := range items {
		hdr := DayHeader(item.Session.StartedAt.Local(), now.Local())
		if hdr != lastHeader {
			if lastHeader != "" {
				fmt.Fprintln(w)
			}
			fmt.Fprintln(w, StyleHeader.Render(hdr))
			lastHeader = hdr
		}
		renderSessionTTY(w, item, now, opts, widths)
		if i+1 < len(items) && DayHeader(items[i+1].Session.StartedAt.Local(), now.Local()) == hdr {
			fmt.Fprintln(w, StyleRail.Render("│"))
		}
	}
	return nil
}

func renderSessionTTY(w io.Writer, item TimelineItem, now time.Time, opts TimelineOptions, widths timelineWidths) {
	s := item.Session
	startLocal := s.StartedAt.Local()
	timeStr := startLocal.Format("15:04")

	activeRaw := " "
	activeMark := activeRaw
	if IsActive(s.LastActivityAt, now) {
		activeRaw = "*"
		activeMark = StyleActive.Render(activeRaw)
	}

	device := ""
	if opts.Slots.Device {
		device = padTrunc(DeviceLabel(opts.DeviceLabels, s.DeviceID), widths.device)
	}
	agent := padTrunc(agentLabel(s.Agent), widths.agent)
	project := ""
	if opts.Slots.Project {
		project = padRight(fitProjectLabel(projectLabel(s), widths.project), widths.project)
	}

	first := ""
	isClean := true
	if s.FirstPrompt != nil {
		first, isClean = CleanFirstPrompt(normalizeDisplayText(*s.FirstPrompt))
	}

	prefixRaw, prefixStyled := timelinePrefix(opts.Layout, opts.Slots, timeStr, activeRaw, activeMark, device, agent, project)
	promptWidth := opts.Width - lipgloss.Width(prefixRaw) - 2
	if promptWidth < 12 {
		promptWidth = 12
	}
	if promptWidth > promptMaxWidth {
		promptWidth = promptMaxWidth
	}

	if !isClean || first == "" {
		// (meta) is rendered muted instead of quoted — it's a label,
		// not user content.
		fmt.Fprintf(w, "%s%s\n", prefixStyled, StyleMuted.Render(MetaPlaceholder))
	} else {
		// Literal quotes, not %q: the content is already normalized to
		// printable runes, and escaping would inflate the row past the
		// width the truncation just computed.
		first = truncateWidth(first, promptWidth)
		fmt.Fprintf(w, "%s\"%s\"\n", prefixStyled, first)
	}

	fmt.Fprintf(
		w, "%s        %s %s %s\n",
		StyleRail.Render("│"),
		StyleRail.Render("├"),
		StyleMuted.Render(padRight("id", searchLabelWidth)),
		StyleAccent.Render(s.ID),
	)

	detail := humanDuration(s.LastActivityAt.Sub(s.StartedAt))
	if tools := topTools(item.Tools, 3); tools != "" {
		detail += " · " + tools
	}
	fmt.Fprintf(
		w, "%s        %s %s\n",
		StyleRail.Render("│"),
		StyleRail.Render("└"),
		StyleMuted.Render(detail),
	)
}

type timelineWidths struct {
	device  int
	agent   int
	project int
}

// Ceilings for the metadata columns. Values are sized to their content
// up to these; anything longer truncates so the prompt keeps room.
const (
	deviceMaxWidth  = 18
	agentMaxWidth   = 12
	projectMaxWidth = 32
)

// timelineColumnWidths sizes the metadata columns from the rows about
// to render: each column takes its widest value, capped by the
// ceilings above. When the terminal is too narrow to keep the prompt
// at promptMinWidth, columns give width back following the contract's
// compression order — device shrinks before project.
func timelineColumnWidths(items []TimelineItem, opts TimelineOptions) timelineWidths {
	w := timelineWidths{}
	for _, it := range items {
		s := it.Session
		if opts.Slots.Device {
			w.device = max(w.device, lipgloss.Width(DeviceLabel(opts.DeviceLabels, s.DeviceID)))
		}
		w.agent = max(w.agent, lipgloss.Width(agentLabel(s.Agent)))
		if opts.Slots.Project {
			w.project = max(w.project, lipgloss.Width(projectLabel(s)))
		}
	}
	w.device = min(w.device, deviceMaxWidth)
	w.agent = min(w.agent, agentMaxWidth)
	w.project = min(w.project, projectMaxWidth)

	// rail(2) + time+active(6) + two spaces after each column + quotes.
	overhead := 2 + 6 + 2 + 2
	for _, cw := range []int{w.device, w.agent, w.project} {
		if cw > 0 {
			overhead += cw + 2
		}
	}
	deficit := promptMinWidth - (opts.Width - overhead)
	if deficit > 0 {
		w.device, deficit = shrinkColumn(w.device, 8, deficit)
		w.project, _ = shrinkColumn(w.project, 14, deficit)
	}
	return w
}

// shrinkColumn takes up to deficit columns away from cur without going
// below floor, returning the new width and the remaining deficit.
func shrinkColumn(cur, floor, deficit int) (int, int) {
	if deficit <= 0 || cur <= floor {
		return cur, deficit
	}
	give := cur - floor
	if give > deficit {
		give = deficit
	}
	return cur - give, deficit - give
}

// fitProjectLabel shortens a project label to n columns keeping the
// distinguishing tail: owner/repo drops the owner first, and whatever
// still overflows truncates from the left per the rendering contract.
func fitProjectLabel(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= n {
		return s
	}
	if i := strings.LastIndex(s, "/"); i >= 0 {
		if tail := s[i+1:]; tail != "" && lipgloss.Width(tail) <= n {
			return tail
		}
	}
	return truncateWidthLeft(s, n)
}

func truncateWidthLeft(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	runes := []rune(s)
	keep := make([]rune, 0, n)
	width := 0
	for i := len(runes) - 1; i >= 0; i-- {
		rw := lipgloss.Width(string(runes[i]))
		if width+rw > n-1 {
			break
		}
		keep = append(keep, runes[i])
		width += rw
	}
	for l, r := 0, len(keep)-1; l < r; l, r = l+1, r-1 {
		keep[l], keep[r] = keep[r], keep[l]
	}
	return "…" + string(keep)
}

// timelinePrefix builds the row's left half. Slots drive which
// optional columns appear; layout drives the order of what remains.
//
//	Global: time  project  device  agent
//	Scoped: time  device   agent   project
//
// When Slots.Device or Slots.Project is false, the column is dropped
// (the strings come in empty) and the surrounding double-space is
// collapsed by buildPrefixSegments to avoid a visual gap.
func timelinePrefix(layout TimelineLayout, slots RowSlots, timeStr, activeRaw, activeStyled, device, agent, project string) (string, string) {
	timeRaw := timeStr + activeRaw
	timeStyled := StyleMuted.Render(timeStr) + activeStyled
	rail := StyleRail.Render("│")

	type seg struct {
		raw    string
		styled string
		show   bool
	}
	timeSeg := seg{timeRaw, timeStyled, true}
	deviceSeg := seg{device, StyleDevice.Render(device), slots.Device}
	agentSeg := seg{agent, StyleAgent.Render(agent), true}
	projectSeg := seg{project, StyleProject.Render(project), slots.Project}

	var order []seg
	if layout == TimelineGlobal {
		order = []seg{timeSeg, projectSeg, deviceSeg, agentSeg}
	} else {
		order = []seg{timeSeg, deviceSeg, agentSeg, projectSeg}
	}

	var rawParts, styledParts []string
	for _, sg := range order {
		if !sg.show || sg.raw == "" {
			continue
		}
		rawParts = append(rawParts, sg.raw)
		styledParts = append(styledParts, sg.styled)
	}
	raw := "│ " + strings.Join(rawParts, "  ") + "  "
	styled := rail + " " + strings.Join(styledParts, "  ") + "  "
	return raw, styled
}

func topTools(tools []session.ToolUsage, limit int) string {
	if len(tools) == 0 || limit <= 0 {
		return ""
	}
	names := make([]string, 0, limit)
	for _, tool := range tools {
		if tool.Name == "" {
			continue
		}
		names = append(names, tool.Name)
		if len(names) == limit {
			break
		}
	}
	return strings.Join(names, ", ")
}

func timelinePlain(w io.Writer, sessions []session.Session) error {
	for _, s := range sessions {
		project := "-"
		if s.ProjectPath != nil {
			project = *s.ProjectPath
		}
		first := ""
		if s.FirstPrompt != nil {
			first = *s.FirstPrompt
		}
		fmt.Fprintf(
			w, "%s\t%s\t%s\t%s\t%s\t%s\n",
			s.StartedAt.UTC().Format(time.RFC3339),
			s.DeviceID,
			s.Agent,
			project,
			humanDuration(s.LastActivityAt.Sub(s.StartedAt)),
			first,
		)
	}
	return nil
}

func humanDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dmin", int(d.Minutes()))
	}
	h := int(d.Hours())
	m := int(d.Minutes()) - h*60
	return fmt.Sprintf("%dh%02d", h, m)
}

func padRight(s string, n int) string {
	if lipgloss.Width(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-lipgloss.Width(s))
}

func padTrunc(s string, n int) string {
	return padRight(truncateWidth(s, n), n)
}

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

func agentLabel(agent string) string {
	if agent == "claude-code" {
		return "claude"
	}
	return agent
}
