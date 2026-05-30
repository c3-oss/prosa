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

const promptMaxRunes = 60

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
		renderSessionTTY(w, item, now, opts)
		if i+1 < len(items) && DayHeader(items[i+1].Session.StartedAt.Local(), now.Local()) == hdr {
			fmt.Fprintln(w, StyleRail.Render("│"))
		}
	}
	return nil
}

func renderSessionTTY(w io.Writer, item TimelineItem, now time.Time, opts TimelineOptions) {
	s := item.Session
	startLocal := s.StartedAt.Local()
	timeStr := startLocal.Format("15:04")

	activeRaw := " "
	activeMark := activeRaw
	if IsActive(s.LastActivityAt, now) {
		activeRaw = "*"
		activeMark = StyleActive.Render(activeRaw)
	}

	widths := timelineColumnWidths(opts.Width)
	device := padTrunc(s.DeviceID, widths.device)
	agent := padTrunc(agentLabel(s.Agent), widths.agent)
	project := padTrunc(projectLabel(s), widths.project)

	first := ""
	if s.FirstPrompt != nil {
		first = normalizeDisplayText(*s.FirstPrompt)
	}

	prefixRaw, prefixStyled := timelinePrefix(opts.Layout, timeStr, activeRaw, activeMark, device, agent, project)
	promptWidth := opts.Width - lipgloss.Width(prefixRaw) - 2
	if promptWidth < 12 {
		promptWidth = 12
	}
	if promptWidth > promptMaxRunes {
		promptWidth = promptMaxRunes
	}
	first = truncateWidth(first, promptWidth)

	fmt.Fprintf(w, "%s%q\n", prefixStyled, first)

	fmt.Fprintf(w, "%s        %s %s %s\n",
		StyleRail.Render("│"),
		StyleRail.Render("├"),
		StyleMuted.Render(padRight("id", 8)),
		StyleAccent.Render(s.ID),
	)

	detail := humanDuration(s.LastActivityAt.Sub(s.StartedAt))
	if tools := topTools(item.Tools, 3); tools != "" {
		detail += " · " + tools
	}
	fmt.Fprintf(w, "%s        %s %s\n",
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

func timelineColumnWidths(width int) timelineWidths {
	switch {
	case width < 72:
		return timelineWidths{device: 6, agent: 7, project: 10}
	case width < 92:
		return timelineWidths{device: 7, agent: 8, project: 12}
	default:
		return timelineWidths{device: 8, agent: 12, project: 14}
	}
}

func timelinePrefix(layout TimelineLayout, timeStr, activeRaw, activeStyled, device, agent, project string) (string, string) {
	timeRaw := timeStr + activeRaw
	timeStyled := StyleMuted.Render(timeStr) + activeStyled
	rail := StyleRail.Render("│")

	if layout == TimelineGlobal {
		raw := fmt.Sprintf("│ %s  %s  %s  %s  ", timeRaw, project, device, agent)
		styled := fmt.Sprintf("%s %s  %s  %s  %s  ",
			rail,
			timeStyled,
			StyleProject.Render(project),
			StyleDevice.Render(device),
			StyleAgent.Render(agent),
		)
		return raw, styled
	}

	raw := fmt.Sprintf("│ %s  %s  %s  %s  ", timeRaw, device, agent, project)
	styled := fmt.Sprintf("%s %s  %s  %s  %s  ",
		rail,
		timeStyled,
		StyleDevice.Render(device),
		StyleAgent.Render(agent),
		StyleProject.Render(project),
	)
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

func projectLabel(s session.Session) string {
	if s.ProjectMarker != nil && *s.ProjectMarker != "" {
		return *s.ProjectMarker
	}
	if s.ProjectPath != nil {
		return lastSegment(*s.ProjectPath)
	}
	if s.ProjectRemote != nil {
		return remoteName(*s.ProjectRemote)
	}
	return "-"
}

func remoteName(remote string) string {
	remote = strings.TrimSuffix(remote, ".git")
	return lastSegment(remote)
}

func lastSegment(path string) string {
	if path == "" {
		return "-"
	}
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}
