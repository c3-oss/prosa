package render

import (
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

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
		fmt.Fprintln(w, "no rows")
		return nil
	}
	if isHeatmapResult(r) {
		return analyticsHeatmapTTY(w, r)
	}
	if isUsageResult(r) {
		return analyticsUsageTTY(w, r)
	}
	cols := make([]TableColumn, len(r.Headers))
	for i, h := range r.Headers {
		cols[i] = TableColumn{Header: h, Right: isNumericCol(h)}
	}
	rows := make([][]TableCell, 0, len(r.Rows))
	for _, row := range r.Rows {
		cells := make([]TableCell, len(row.Values))
		for i, v := range row.Values {
			if i < len(r.Headers) {
				cells[i] = analyticsCell(r.Headers[i], toString(v))
			} else {
				cells[i] = Cell(toString(v))
			}
		}
		rows = append(rows, cells)
	}
	return Table(w, cols, rows, true)
}

// analyticsCell applies the TTY-only humanizations: numeric columns
// get thousands separators and the accent tone, PROJECT collapses git
// remotes to owner/repo and $HOME paths to ~, STARTED becomes local
// wall-clock time, EST_COST_USD reads as dollars. Plain output keeps
// the raw values.
func analyticsCell(header, s string) TableCell {
	switch header {
	case "PROJECT":
		return Cell(displayProject(s))
	case "STARTED":
		return TableCell{Text: displayTimestamp(s), Style: StyleMuted}
	case "EST_COST_USD":
		return TableCell{Text: formatCost(s), Style: StyleAccent}
	}
	if isNumericCol(header) {
		return TableCell{Text: formatNumericText(s), Style: StyleAccent}
	}
	return Cell(s)
}

func formatNumericText(s string) string {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return s
	}
	return formatInt(n)
}

// displayProject rewrites a project identity for reading: git remotes
// collapse to "owner/repo", home-anchored paths abbreviate to ~.
func displayProject(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "/") {
		return AbbreviateHome(s)
	}
	if n := NormalizeRemote(s); n != "" {
		return n
	}
	return s
}

// AbbreviateHome rewrites an absolute path under $HOME to the ~ form.
func AbbreviateHome(p string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	if p == home {
		return "~"
	}
	if strings.HasPrefix(p, home+"/") {
		return "~" + p[len(home):]
	}
	return p
}

// displayTimestamp renders an RFC3339 instant as local wall-clock
// time, day-grained like the rest of the CLI. Unparseable values pass
// through untouched.
func displayTimestamp(s string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return s
	}
	return t.Local().Format("2006-01-02 15:04")
}

type heatmapDay struct {
	date  time.Time
	label string
	count int64
}

func analyticsHeatmapTTY(w io.Writer, r store.AnalyticsResult) error {
	days := parseHeatmapDays(r)
	if len(days) == 0 {
		fmt.Fprintln(w, "no rows")
		return nil
	}
	counts := make(map[string]int64, len(days))
	var total, max int64
	for _, d := range days {
		counts[d.label] = d.count
		total += d.count
		if d.count > max {
			max = d.count
		}
	}

	first := days[0].date
	last := days[len(days)-1].date
	fmt.Fprintf(
		w, "%s  %s\n",
		StyleHeader.Render("sessions/day"),
		StyleMuted.Render(fmt.Sprintf(
			"%s .. %s · %s sessions",
			first.Format("2006-01-02"),
			last.Format("2006-01-02"),
			formatInt(total),
		)),
	)
	fmt.Fprintln(w)

	start := first.AddDate(0, 0, -int(first.Weekday()))
	end := last.AddDate(0, 0, 6-int(last.Weekday()))
	weekdays := []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	for weekday, label := range weekdays {
		fmt.Fprintf(w, "%s ", StyleMuted.Render(label))
		for d := start.AddDate(0, 0, weekday); !d.After(end); d = d.AddDate(0, 0, 7) {
			if d.Before(first) || d.After(last) {
				fmt.Fprint(w, " ")
				continue
			}
			fmt.Fprint(w, heatmapCell(counts[d.Format("2006-01-02")], max))
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(
		w, "%s %s%s%s%s %s\n",
		StyleMuted.Render("less"),
		StyleRail.Render("■"),
		heatmapCell(max/4, max),
		heatmapCell(max/2, max),
		heatmapCell(max, max),
		StyleMuted.Render("more"),
	)
	return nil
}

func parseHeatmapDays(r store.AnalyticsResult) []heatmapDay {
	out := make([]heatmapDay, 0, len(r.Rows))
	for _, row := range r.Rows {
		if len(row.Values) < 2 {
			continue
		}
		label := toString(row.Values[0])
		d, err := time.Parse("2006-01-02", label)
		if err != nil {
			continue
		}
		out = append(out, heatmapDay{
			date:  d,
			label: label,
			count: parseInt(row.Values[1]),
		})
	}
	return out
}

func heatmapCell(count, max int64) string {
	if count <= 0 || max <= 0 {
		return StyleRail.Render("■")
	}
	colors := []lipgloss.Color{
		lipgloss.Color("#3E5E4C"),
		lipgloss.Color("#5F8B68"),
		lipgloss.Color("#8CBF88"),
		lipgloss.Color("#D6B97A"),
	}
	bucket := int((count - 1) * int64(len(colors)) / max)
	if bucket < 0 {
		bucket = 0
	}
	if bucket >= len(colors) {
		bucket = len(colors) - 1
	}
	return lipgloss.NewStyle().Foreground(colors[bucket]).Render("■")
}

type usageRow struct {
	agent    string
	sessions int64
	measured int64
	total    int64
	input    int64
	output   int64
	cached   int64
	cost     string
}

func analyticsUsageTTY(w io.Writer, r store.AnalyticsResult) error {
	rows := parseUsageRows(r)
	if len(rows) == 0 {
		fmt.Fprintln(w, "no rows")
		return nil
	}
	var maxTotal int64
	for _, row := range rows {
		if row.total > maxTotal {
			maxTotal = row.total
		}
	}

	widths := []int{len("AGENT"), len("SESS"), len("MEASURED"), len("TOTAL"), len("COST")}
	for _, row := range rows {
		widths[0] = max(widths[0], lipgloss.Width(row.agent))
		widths[1] = max(widths[1], lipgloss.Width(formatInt(row.sessions)))
		widths[2] = max(widths[2], lipgloss.Width(formatInt(row.measured)))
		widths[3] = max(widths[3], lipgloss.Width(formatInt(row.total)))
		widths[4] = max(widths[4], lipgloss.Width(formatCost(row.cost)))
	}

	headers := []string{"AGENT", "SESS", "MEASURED", "TOTAL", "COST"}
	for i, h := range headers {
		if i > 0 {
			fmt.Fprint(w, "  ")
		}
		aligned := padRight(h, widths[i])
		if i > 0 {
			aligned = padLeft(h, widths[i])
		}
		fmt.Fprint(w, StyleHeader.Foreground(ColorMuted).Render(aligned))
	}
	fmt.Fprintf(w, "  %s\n", StyleHeader.Foreground(ColorMuted).Render("TOKENS"))

	for _, row := range rows {
		values := []string{
			row.agent,
			formatInt(row.sessions),
			formatInt(row.measured),
			formatInt(row.total),
			formatCost(row.cost),
		}
		for i, v := range values {
			if i > 0 {
				fmt.Fprint(w, "  ")
			}
			if i == 0 {
				fmt.Fprint(w, padRight(v, widths[i]))
				continue
			}
			cell := padLeft(v, widths[i])
			if i == 4 && row.cost == "" {
				fmt.Fprint(w, StyleMuted.Render(cell))
				continue
			}
			fmt.Fprint(w, StyleAccent.Render(cell))
		}
		fmt.Fprintf(w, "  %s\n", usageBar(row.total, maxTotal, 18))
		fmt.Fprintf(
			w, "%s%s\n",
			strings.Repeat(" ", widths[0]+2),
			StyleMuted.Render(fmt.Sprintf(
				"input %s · output %s · cached %s",
				formatInt(row.input),
				formatInt(row.output),
				formatInt(row.cached),
			)),
		)
	}
	return nil
}

func parseUsageRows(r store.AnalyticsResult) []usageRow {
	out := make([]usageRow, 0, len(r.Rows))
	for _, row := range r.Rows {
		if len(row.Values) < 8 {
			continue
		}
		out = append(out, usageRow{
			agent:    toString(row.Values[0]),
			sessions: parseInt(row.Values[1]),
			measured: parseInt(row.Values[2]),
			total:    parseInt(row.Values[3]),
			input:    parseInt(row.Values[4]),
			output:   parseInt(row.Values[5]),
			cached:   parseInt(row.Values[6]),
			cost:     toString(row.Values[7]),
		})
	}
	return out
}

func usageBar(value, max int64, width int) string {
	if width <= 0 {
		return ""
	}
	if value <= 0 || max <= 0 {
		return StyleRail.Render(strings.Repeat("░", width))
	}
	filled := int((value*int64(width) + max - 1) / max)
	if filled < 1 {
		filled = 1
	}
	if filled > width {
		filled = width
	}
	return StyleAccent.Render(strings.Repeat("█", filled)) +
		StyleRail.Render(strings.Repeat("░", width-filled))
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
	case "SESSIONS", "TURNS", "USES", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD":
		return true
	}
	return false
}

func isHeatmapResult(r store.AnalyticsResult) bool {
	return sameHeaders(r.Headers, []string{"DATE", "SESSIONS"})
}

func isUsageResult(r store.AnalyticsResult) bool {
	return sameHeaders(r.Headers, []string{"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD"})
}

func sameHeaders(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func parseInt(v any) int64 {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int64:
		return x
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return n
	default:
		n, _ := strconv.ParseInt(strings.TrimSpace(fmt.Sprintf("%v", x)), 10, 64)
		return n
	}
}

func formatInt(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return sign + s
}

// formatCost renders an estimated USD amount for reading: grouped
// dollars, two decimal places. Values that fail to parse keep the raw
// text so no information silently disappears.
func formatCost(s string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return "n/a"
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return "$" + t
	}
	cents := int64(math.Round(f * 100))
	return fmt.Sprintf("$%s.%02d", formatInt(cents/100), cents%100)
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	default:
		return fmt.Sprintf("%v", x)
	}
}
