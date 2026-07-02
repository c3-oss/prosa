package render

import (
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/charmbracelet/lipgloss"

	"github.com/c3-oss/prosa/internal/store"
)

const (
	snippetMarkStart = "«"
	snippetMarkEnd   = "»"
	// searchLabelWidth shares the label column across the search hit
	// body so the role and the "session" label align flush.
	searchLabelWidth = 9
)

// shortenID returns up to the first 12 runes of an id, trimming the
// trailing UUID hex past that. Keeps the search header from being
// dominated by a 36-char UUID.
func shortenID(id string) string {
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}

type SearchOptions struct {
	Interactive bool
	Width       int
	// DeviceLabels maps device_id → friendly_name so search hits show
	// "Studio M4" instead of the raw fingerprint hex.
	DeviceLabels map[string]string
	// HideProject drops the project segment from the meta line. The
	// timeline/search context line already names the project when the
	// caller is scoped.
	HideProject bool
	// HideDevice drops the device segment from the meta line — used
	// when every hit shares the same device (cardinality 1).
	HideDevice bool
}

// SearchHits prints one block per hit: a session header line followed by
// a snippet sub-line with the matched terms highlighted.
func SearchHits(w io.Writer, hits []store.SearchHit, now time.Time, interactive bool) error {
	return SearchHitsWithOptions(w, hits, now, SearchOptions{Interactive: interactive, Width: 80})
}

func SearchHitsWithOptions(w io.Writer, hits []store.SearchHit, now time.Time, opts SearchOptions) error {
	if opts.Width <= 0 {
		opts.Width = 80
	}
	for _, h := range hits {
		startLocal := h.Session.StartedAt.Local()
		date := searchTimeLabel(startLocal, now.Local())

		project := projectLabel(h.Session)
		if !opts.Interactive && h.Session.ProjectPath != nil {
			project = *h.Session.ProjectPath
		}
		first := ""
		firstIsMeta := false
		if h.Session.FirstPrompt != nil {
			candidate := normalizeDisplayText(*h.Session.FirstPrompt)
			cleaned, ok := CleanFirstPrompt(candidate)
			switch {
			case ok && cleaned != "":
				first = truncateWidth(cleaned, 60)
			case !ok:
				firstIsMeta = true
			}
		}

		if opts.Interactive {
			idShort := shortenID(h.Session.ID)
			segs := []string{}
			if !opts.HideProject {
				segs = append(segs, StyleProject.Render(project))
			}
			segs = append(segs, StyleAgent.Render(agentLabel(h.Session.Agent)))
			if !opts.HideDevice {
				segs = append(segs, StyleDevice.Render(DeviceLabel(opts.DeviceLabels, h.Session.DeviceID)))
			}
			segs = append(segs, StyleMuted.Render(date))
			fmt.Fprintf(
				w, "%s %s  %s\n",
				StyleRail.Render("│"),
				StyleAccent.Render(idShort),
				strings.Join(segs, " · "),
			)
			fmt.Fprintf(
				w, "%s   %s %s\n",
				StyleRail.Render("│"),
				StyleAgent.Render(padTrunc(h.Role, searchLabelWidth)),
				highlightSnippet(truncateMarkedSnippet(h.Snippet, opts.Width-16)),
			)
			switch {
			case first != "":
				fmt.Fprintf(
					w, "%s   %s \"%s\"\n",
					StyleRail.Render("│"),
					StyleMuted.Render(padRight("session", searchLabelWidth)),
					first,
				)
			case firstIsMeta:
				fmt.Fprintf(
					w, "%s   %s %s\n",
					StyleRail.Render("│"),
					StyleMuted.Render(padRight("session", searchLabelWidth)),
					StyleMuted.Render(MetaPlaceholder),
				)
			}
			fmt.Fprintf(w, "%s\n", StyleRail.Render("│"))
		} else {
			fmt.Fprintf(
				w, "%s\t%s\t%s\t%s\t%s\t%s\n",
				h.Session.ID,
				h.Session.Agent,
				project,
				startLocal.Format("2006-01-02 15:04"),
				h.Role,
				flattenSnippet(h.Snippet),
			)
		}
	}
	if opts.Interactive {
		fmt.Fprintf(w, "%s · use `prosa show <id>` for raw JSONL\n",
			StyleMuted.Render(fmt.Sprintf("%d matches", len(hits))))
	}
	return nil
}

func highlightSnippet(s string) string {
	// Manual scan — avoids a regex import for such a tight loop.
	var b strings.Builder
	rest := s
	for {
		i := strings.Index(rest, snippetMarkStart)
		if i < 0 {
			b.WriteString(rest)
			return b.String()
		}
		j := strings.Index(rest[i+len(snippetMarkStart):], snippetMarkEnd)
		if j < 0 {
			b.WriteString(rest)
			return b.String()
		}
		b.WriteString(rest[:i])
		match := rest[i+len(snippetMarkStart) : i+len(snippetMarkStart)+j]
		b.WriteString(StyleMatch.Render(match))
		rest = rest[i+len(snippetMarkStart)+j+len(snippetMarkEnd):]
	}
}

// truncateMarkedSnippet fits a «»-marked snippet into n display
// columns while keeping the first match visible: when the match sits
// past the cut, the window shifts left so roughly a third of context
// precedes it. Marker pairs survive truncation so highlights stay
// attached to the matched text.
func truncateMarkedSnippet(s string, n int) string {
	if n <= 0 {
		return ""
	}
	s = normalizeDisplayText(s)
	if s == "" {
		return s
	}

	type markedRune struct {
		r      rune
		w      int
		marked bool
	}
	var runes []markedRune
	marked := false
	total := 0
	for i := 0; i < len(s); {
		switch {
		case strings.HasPrefix(s[i:], snippetMarkStart):
			marked = true
			i += len(snippetMarkStart)
		case strings.HasPrefix(s[i:], snippetMarkEnd):
			marked = false
			i += len(snippetMarkEnd)
		default:
			r, size := utf8.DecodeRuneInString(s[i:])
			w := lipgloss.Width(string(r))
			runes = append(runes, markedRune{r: r, w: w, marked: marked})
			total += w
			i += size
		}
	}
	if total <= n {
		return s
	}

	firstMatch := 0
	for i, mr := range runes {
		if mr.marked {
			firstMatch = i
			break
		}
	}
	widthBefore := 0
	for _, mr := range runes[:firstMatch] {
		widthBefore += mr.w
	}
	start := 0
	if widthBefore > n*2/3 {
		keepBefore := n / 3
		trim := widthBefore - keepBefore
		for start < firstMatch && trim > 0 {
			trim -= runes[start].w
			start++
		}
	}

	var b strings.Builder
	budget := n
	if start > 0 {
		b.WriteString("…")
		budget--
	}
	inMark := false
	used := 0
	i := start
	for ; i < len(runes); i++ {
		mr := runes[i]
		// Hold one column back for the trailing ellipsis unless this
		// rune is the last one and closes the line exactly.
		reserve := 0
		if i+1 < len(runes) {
			reserve = 1
		}
		if used+mr.w > budget-reserve {
			break
		}
		if mr.marked && !inMark {
			b.WriteString(snippetMarkStart)
			inMark = true
		}
		if !mr.marked && inMark {
			b.WriteString(snippetMarkEnd)
			inMark = false
		}
		b.WriteRune(mr.r)
		used += mr.w
	}
	if inMark {
		b.WriteString(snippetMarkEnd)
	}
	if i < len(runes) {
		b.WriteString("…")
	}
	return b.String()
}

// flattenSnippet strips the FTS5 markers entirely for non-TTY output so
// shell pipelines see plain text.
func flattenSnippet(s string) string {
	s = strings.ReplaceAll(s, snippetMarkStart, "")
	s = strings.ReplaceAll(s, snippetMarkEnd, "")
	return normalizeDisplayText(s)
}

// normalizeDisplayText flattens whitespace runs to single spaces and
// drops non-printable runes so row content can render inside literal
// quotes without escaping.
func normalizeDisplayText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return -1
	}, strings.Join(strings.Fields(s), " "))
}

func searchTimeLabel(t, now time.Time) string {
	day := DayHeader(t, now)
	switch day {
	case "Today", "Yesterday":
		return day + " " + t.Format("15:04")
	default:
		return t.Format("2006-01-02 15:04")
	}
}
