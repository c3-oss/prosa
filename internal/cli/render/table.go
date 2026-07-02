package render

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// TableColumn describes one column of a dense CLI table. Right-aligned
// columns hold numbers so magnitudes line up for rapid comparison.
type TableColumn struct {
	Header string
	Right  bool
}

// TableCell is one rendered value. Style applies after alignment so
// padding is computed on the visible text, not on escape sequences.
type TableCell struct {
	Text  string
	Style lipgloss.Style
}

// Cell wraps plain text in an unstyled TableCell.
func Cell(s string) TableCell { return TableCell{Text: s} }

// Table writes a fixed-width table: bold muted headers and
// display-width-aligned columns in interactive mode, tab-separated rows
// otherwise so shell pipelines keep a stable machine-friendly shape.
func Table(w io.Writer, cols []TableColumn, rows [][]TableCell, interactive bool) error {
	if !interactive {
		headers := make([]string, len(cols))
		for i, c := range cols {
			headers[i] = c.Header
		}
		fmt.Fprintln(w, strings.Join(headers, "\t"))
		for _, row := range rows {
			cells := make([]string, len(row))
			for i, c := range row {
				cells[i] = c.Text
			}
			fmt.Fprintln(w, strings.Join(cells, "\t"))
		}
		return nil
	}

	widths := make([]int, len(cols))
	for i, c := range cols {
		widths[i] = lipgloss.Width(c.Header)
	}
	for _, row := range rows {
		for i, c := range row {
			if i < len(widths) {
				widths[i] = max(widths[i], lipgloss.Width(c.Text))
			}
		}
	}

	hdr := StyleHeader.Foreground(ColorMuted)
	for i, c := range cols {
		if i > 0 {
			fmt.Fprint(w, "  ")
		}
		fmt.Fprint(w, hdr.Render(tableAlign(c.Header, widths[i], c.Right, i == len(cols)-1)))
	}
	fmt.Fprintln(w)

	for _, row := range rows {
		for i, c := range row {
			if i > 0 {
				fmt.Fprint(w, "  ")
			}
			right := i < len(cols) && cols[i].Right
			fmt.Fprint(w, c.Style.Render(tableAlign(c.Text, widths[i], right, i == len(row)-1)))
		}
		fmt.Fprintln(w)
	}
	return nil
}

// tableAlign pads a cell to its column width. The last column skips
// left-aligned padding so rows carry no trailing whitespace.
func tableAlign(s string, n int, right, last bool) string {
	if right {
		return padLeft(s, n)
	}
	if last {
		return s
	}
	return padRight(s, n)
}

func padLeft(s string, n int) string {
	if lipgloss.Width(s) >= n {
		return s
	}
	return strings.Repeat(" ", n-lipgloss.Width(s)) + s
}
