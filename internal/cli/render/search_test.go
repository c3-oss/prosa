package render

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

func TestSearchHitsInteractiveEvidenceBlocks(t *testing.T) {
	now := time.Date(2026, 5, 30, 15, 0, 0, 0, time.Local)
	hits := []store.SearchHit{{
		Session: session.Session{
			ID:             "57f476a0-8e11-4f6d-83a0-5b1e4df16337",
			Agent:          "codex",
			DeviceID:       "laptop",
			ProjectPath:    strp("/Users/upsetbit/Projects/c3/c3-oss/prosa"),
			StartedAt:      now.Add(-time.Hour),
			LastActivityAt: now.Add(-30 * time.Minute),
			FirstPrompt:    strp("index importer sessions"),
		},
		Role: "user",
		Snippet: `Verifique e corrija em «@iac/»

Utilize newrelic, se quiser.`,
	}}

	var b bytes.Buffer
	err := SearchHitsWithOptions(&b, hits, now, SearchOptions{Interactive: true, Width: 96})
	require.NoError(t, err)
	out := b.String()

	require.Contains(t, out, "│")
	// ID is shortened into the header line.
	require.Contains(t, out, "57f476a0-8e1")
	require.NotContains(t, out, "57f476a0-8e11-4f6d-83a0-5b1e4df16337",
		"full UUID should be shortened in the header")
	require.Contains(t, out, "prosa")
	require.Contains(t, out, "codex")
	require.Contains(t, out, "laptop")
	require.Contains(t, out, "user")
	require.Contains(t, out, "@iac/")
	require.Contains(t, out, "Utilize newrelic")
	require.NotContains(t, out, "\n\nUtilize")
	require.Contains(t, out, "session")
	require.Contains(t, out, `"index importer sessions"`)
	require.Contains(t, out, "1 matches")
	// New shape: no ├/└ branches in the body — only the rail │.
	require.NotContains(t, out, "├",
		"new search body should not use ├ branches")
}

func TestSearchHitsPlainStripsMarkers(t *testing.T) {
	now := time.Date(2026, 5, 30, 15, 0, 0, 0, time.Local)
	hits := []store.SearchHit{{
		Session: session.Session{
			ID:             "codex-2026-05-30-1342",
			Agent:          "codex",
			DeviceID:       "laptop",
			ProjectPath:    strp("/work/prosa"),
			StartedAt:      now.Add(-time.Hour),
			LastActivityAt: now.Add(-30 * time.Minute),
		},
		Role:    "user",
		Snippet: "add a local «sqlite» store",
	}}

	var b bytes.Buffer
	err := SearchHitsWithOptions(&b, hits, now, SearchOptions{Interactive: false})
	require.NoError(t, err)
	out := b.String()

	require.Equal(t, "codex-2026-05-30-1342\tcodex\t/work/prosa\t2026-05-30 14:00\tuser\tadd a local sqlite store\n", out)
	require.NotContains(t, out, "«")
	require.NotContains(t, out, "»")
	require.False(t, strings.Contains(out, "\x1b["), "plain output must not contain ANSI escapes")
}

func TestTruncateMarkedSnippetKeepsHighlightPastCut(t *testing.T) {
	t.Parallel()

	long := strings.Repeat("x", 100) + " «sqlite» store " + strings.Repeat("y", 40)
	got := truncateMarkedSnippet(long, 60)
	require.Contains(t, got, "«sqlite»", "markers must survive truncation")
	require.True(t, strings.HasPrefix(got, "…"), "window shifted left needs a leading ellipsis")
	require.True(t, strings.HasSuffix(got, "…"), "cut tail needs a trailing ellipsis")
}

func TestTruncateMarkedSnippetShortPassthrough(t *testing.T) {
	t.Parallel()

	require.Equal(t, "uses «sqlite» here", truncateMarkedSnippet("uses «sqlite» here", 60))
}

func TestTruncateMarkedSnippetEarlyMatchKeepsHead(t *testing.T) {
	t.Parallel()

	long := "«sqlite» is used " + strings.Repeat("z", 100)
	got := truncateMarkedSnippet(long, 40)
	require.True(t, strings.HasPrefix(got, "«sqlite»"), "early match keeps the snippet head, got %q", got)
	require.True(t, strings.HasSuffix(got, "…"))
}
