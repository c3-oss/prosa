package render

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/c3-oss/prosa/internal/store"
)

// Analytics writes the result as a fixed-width table. In TTY mode the
// header is bold/dim, numeric columns use a soft accent; out of TTY the same
// data is tab-separated with no styling so shell pipelines parse it
// trivially.
func Analytics(w io.Writer, r store.AnalyticsResult, interactive bool) error {
	if !interactive {
		return analyticsPlain(w, r)
	}
	return analyticsTTY(w, r)
}

func analyticsTTY(w io.Writer, r store.AnalyticsResult) error {
	if len(r.Rows) == 0 {
		fmt.Fprintln(w, "  (no rows)")
		return nil
	}
	widths := make([]int, len(r.Headers))
	for i, h := range r.Headers {
		widths[i] = lipgloss.Width(h)
	}
	for _, row := range r.Rows {
		for i, v := range row.Values {
			s := toString(v)
			if lipgloss.Width(s) > widths[i] {
				widths[i] = lipgloss.Width(s)
			}
		}
	}

	// Header row.
	for i, h := range r.Headers {
		if i > 0 {
			fmt.Fprint(w, "  ")
		}
		fmt.Fprint(w, StyleHeader.Foreground(ColorMuted).Render(padRight(h, widths[i])))
	}
	fmt.Fprintln(w)

	// Data rows.
	for _, row := range r.Rows {
		for i, v := range row.Values {
			if i > 0 {
				fmt.Fprint(w, "  ")
			}
			s := padRight(toString(v), widths[i])
			if isNumericCol(r.Headers[i]) {
				fmt.Fprint(w, StyleAccent.Render(s))
			} else {
				fmt.Fprint(w, s)
			}
		}
		fmt.Fprintln(w)
	}
	return nil
}

func analyticsPlain(w io.Writer, r store.AnalyticsResult) error {
	fmt.Fprintln(w, strings.Join(r.Headers, "\t"))
	for _, row := range r.Rows {
		strs := make([]string, len(row.Values))
		for i, v := range row.Values {
			strs[i] = toString(v)
		}
		fmt.Fprintln(w, strings.Join(strs, "\t"))
	}
	return nil
}

func isNumericCol(name string) bool {
	switch name {
	case "SESSIONS", "TURNS", "USES":
		return true
	}
	return false
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	default:
		return fmt.Sprintf("%v", x)
	}
}
