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

// Timeline writes sessions to w grouped by day with Lipgloss colors when
// interactive == true, or as plain tab-separated lines otherwise.
func Timeline(w io.Writer, sessions []session.Session, now time.Time, interactive bool) error {
	if !interactive {
		return timelinePlain(w, sessions)
	}

	var lastHeader string
	for _, s := range sessions {
		hdr := DayHeader(s.StartedAt.Local(), now.Local())
		if hdr != lastHeader {
			if lastHeader != "" {
				fmt.Fprintln(w)
			}
			fmt.Fprintln(w, StyleHeader.Render(hdr))
			lastHeader = hdr
		}
		renderSessionTTY(w, s, now)
	}
	return nil
}

func renderSessionTTY(w io.Writer, s session.Session, now time.Time) {
	startLocal := s.StartedAt.Local()
	timeStr := startLocal.Format("15:04")

	activeMark := " "
	if IsActive(s.LastActivityAt, now) {
		activeMark = StyleActive.Render("*")
	}

	project := "-"
	if s.ProjectPath != nil {
		project = lastSegment(*s.ProjectPath)
	}
	first := ""
	if s.FirstPrompt != nil {
		first = truncateRunes(*s.FirstPrompt, promptMaxRunes)
	}

	fmt.Fprintf(
		w, "  %s%s  %s  %s  %s  %q\n",
		StyleMuted.Render(timeStr),
		activeMark,
		StyleDevice.Render(padRight(s.DeviceID, 8)),
		StyleAgent.Render(padRight(s.Agent, 12)),
		StyleProject.Render(padRight(project, 14)),
		first,
	)
	dur := s.LastActivityAt.Sub(s.StartedAt)
	fmt.Fprintf(w, "         %s\n", StyleMuted.Render("⤷ "+humanDuration(dur)))
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

func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n-1]) + "…"
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
