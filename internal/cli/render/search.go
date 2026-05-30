package render

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/store"
)

const (
	snippetMarkStart = "«"
	snippetMarkEnd   = "»"
)

type SearchOptions struct {
	Interactive bool
	Width       int
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
		if h.Session.FirstPrompt != nil {
			first = truncateWidth(*h.Session.FirstPrompt, 60)
		}

		if opts.Interactive {
			id := padTrunc(shortSessionID(h.Session.ID), 12)
			meta := fmt.Sprintf("%s · %s · %s · %s",
				StyleProject.Render(project),
				StyleAgent.Render(agentLabel(h.Session.Agent)),
				StyleDevice.Render(h.Session.DeviceID),
				StyleMuted.Render(date),
			)
			fmt.Fprintf(w, "%s %s %s\n", StyleRail.Render("│"), StyleAccent.Render(id), meta)
			fmt.Fprintf(w, "%s   %s %s\n",
				StyleRail.Render("│"),
				StyleAgent.Render(padTrunc(h.Role, 9)),
				highlightSnippet(truncateMarkedSnippet(h.Snippet, opts.Width-16)),
			)
			if first != "" {
				fmt.Fprintf(w, "%s   %s %q\n",
					StyleRail.Render("│"),
					StyleMuted.Render(padRight("session", 9)),
					first,
				)
			}
			fmt.Fprintf(w, "%s\n", StyleRail.Render("│"))
		} else {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n",
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
	// Replace each «...» occurrence with the styled rendering. Walk the
	// string manually so we don't rely on regex (no regex import for
	// such a tight loop).
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

func truncateMarkedSnippet(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) == 0 {
		return s
	}
	plain := flattenSnippet(s)
	if len([]rune(plain)) <= n {
		return s
	}
	return truncateWidth(plain, n)
}

// flattenSnippet strips the FTS5 markers entirely for non-TTY output so
// shell pipelines see plain text.
func flattenSnippet(s string) string {
	s = strings.ReplaceAll(s, snippetMarkStart, "")
	s = strings.ReplaceAll(s, snippetMarkEnd, "")
	return strings.Join(strings.Fields(s), " ")
}

func shortSessionID(id string) string {
	return truncateWidth(id, 12)
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
