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

// SearchHits prints one block per hit: a session header line followed by
// a snippet sub-line with the matched terms highlighted.
func SearchHits(w io.Writer, hits []store.SearchHit, now time.Time, interactive bool) error {
	for _, h := range hits {
		startLocal := h.Session.StartedAt.Local()
		date := startLocal.Format("2006-01-02 15:04")

		project := "-"
		if h.Session.ProjectPath != nil {
			if interactive {
				project = lastSegment(*h.Session.ProjectPath)
			} else {
				project = *h.Session.ProjectPath
			}
		}
		first := ""
		if h.Session.FirstPrompt != nil {
			first = truncateRunes(*h.Session.FirstPrompt, 60)
		}

		if interactive {
			fmt.Fprintf(w, "  %s  %s  %s  %s  %q\n",
				StyleMuted.Render(date),
				StyleDevice.Render(padRight(h.Session.DeviceID, 8)),
				StyleAgent.Render(padRight(h.Session.Agent, 12)),
				StyleProject.Render(padRight(project, 14)),
				first,
			)
			fmt.Fprintf(w, "       %s %s: %s\n",
				StyleMuted.Render("⤷"),
				StyleAgent.Render(h.Role),
				highlightSnippet(h.Snippet),
			)
		} else {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n",
				h.Session.ID,
				h.Session.Agent,
				project,
				date,
				h.Role,
				flattenSnippet(h.Snippet),
			)
		}
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

// flattenSnippet strips the FTS5 markers entirely for non-TTY output so
// shell pipelines see plain text.
func flattenSnippet(s string) string {
	s = strings.ReplaceAll(s, snippetMarkStart, "")
	s = strings.ReplaceAll(s, snippetMarkEnd, "")
	return strings.Join(strings.Fields(s), " ")
}
