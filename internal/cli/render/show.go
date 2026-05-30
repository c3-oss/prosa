package render

import (
	"fmt"
	"io"
	"strings"

	"github.com/c3-oss/prosa/pkg/session"
)

type SessionDetail struct {
	Session session.Session
	Tools   []session.ToolUsage
	Turns   []session.Turn
	Width   int
	// MaxOutputLines caps the number of lines printed per turn. 0 means
	// the renderer falls back to a single-line collapse — backwards
	// compatible with callers that haven't opted into per-line preview.
	MaxOutputLines int
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
		label := turnLabel(turn)
		branch := "├"
		if i+1 == len(d.Turns) {
			branch = "└"
		}
		railHead := fmt.Sprintf("%s %s %s ",
			StyleRail.Render("│"),
			StyleRail.Render(branch),
			StyleAgent.Render(padTrunc(label, 11)),
		)
		railCont := fmt.Sprintf("%s   %s ",
			StyleRail.Render("│"),
			padTrunc("", 11),
		)

		lines := turnPreviewLines(turn.Content, d.MaxOutputLines)
		for j, ln := range lines {
			head := railHead
			if j > 0 {
				head = railCont
			}
			fmt.Fprintf(w, "%s%s\n", head, truncateWidth(ln, contentWidth))
		}
	}
	return nil
}

// turnLabel renders the per-row identifier. Tool projections show as
// "tool:<name>" so the reader instantly sees which command produced
// the evidence; everything else stays on the bare role.
func turnLabel(t session.Turn) string {
	if t.Kind == session.KindToolResult && t.ToolName != "" {
		return "tool:" + t.ToolName
	}
	return t.Role
}

// turnPreviewLines returns the lines to display for one turn. When
// max <= 0 the renderer falls back to the legacy single-line collapse
// (newlines/whitespace normalized to spaces) — keeps short scripts
// stable. When max > 0 the content is split on newlines, capped to
// max lines, and a trailing "…" sentinel marks truncation.
func turnPreviewLines(content string, max int) []string {
	if max <= 0 {
		return []string{normalizeDisplayText(content)}
	}
	raw := strings.Split(content, "\n")
	if len(raw) <= max {
		return raw
	}
	out := make([]string, 0, max+1)
	out = append(out, raw[:max]...)
	out = append(out, "…")
	return out
}
