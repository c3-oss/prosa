package render

import (
	"fmt"
	"io"

	"github.com/c3-oss/prosa/pkg/session"
)

type SessionDetail struct {
	Session session.Session
	Tools   []session.ToolUsage
	Turns   []session.Turn
	Width   int
}

func ShowSession(w io.Writer, d SessionDetail) error {
	if d.Width <= 0 {
		d.Width = 80
	}
	s := d.Session

	fmt.Fprintln(w, StyleHeader.Render("session"))
	fmt.Fprintf(w, "%s %s · %s · %s\n",
		StyleRail.Render("│"),
		StyleProject.Render(projectLabel(s)),
		StyleAgent.Render(agentLabel(s.Agent)),
		StyleDevice.Render(s.DeviceID),
	)

	fields := []struct {
		label string
		value string
	}{
		{"id", StyleAccent.Render(s.ID)},
		{"started", s.StartedAt.Local().Format("2006-01-02 15:04")},
		{"duration", humanDuration(s.LastActivityAt.Sub(s.StartedAt))},
	}
	if s.Model != nil && *s.Model != "" {
		fields = append(fields, struct {
			label string
			value string
		}{"model", *s.Model})
	}
	if tools := topTools(d.Tools, 5); tools != "" {
		fields = append(fields, struct {
			label string
			value string
		}{"tools", tools})
	}
	fields = append(fields, struct {
		label string
		value string
	}{"raw", s.RawPath})

	for i, field := range fields {
		branch := "├"
		if i+1 == len(fields) {
			branch = "└"
		}
		fmt.Fprintf(w, "%s   %s %s %s\n",
			StyleRail.Render("│"),
			StyleRail.Render(branch),
			StyleMuted.Render(padRight(field.label, 9)),
			field.value,
		)
	}

	fmt.Fprintln(w)
	fmt.Fprintln(w, StyleHeader.Render("turns"))
	if len(d.Turns) == 0 {
		fmt.Fprintf(w, "%s %s\n", StyleRail.Render("│"), StyleMuted.Render("no projected turns; use `prosa show --raw <id>` for preserved source"))
		return nil
	}

	contentWidth := d.Width - 16
	if contentWidth < 24 {
		contentWidth = 24
	}
	for i, turn := range d.Turns {
		text := truncateWidth(normalizeDisplayText(turn.Content), contentWidth)
		role := padTrunc(turn.Role, 9)
		branch := "├"
		if i+1 == len(d.Turns) {
			branch = "└"
		}
		fmt.Fprintf(w, "%s %s %s %s\n",
			StyleRail.Render("│"),
			StyleRail.Render(branch),
			StyleAgent.Render(role),
			text,
		)
	}
	return nil
}
