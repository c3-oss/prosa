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
			ID:             "codex-2026-05-30-1342",
			Agent:          "codex",
			DeviceID:       "laptop",
			ProjectPath:    strp("/Users/upsetbit/Projects/c3/c3-oss/prosa"),
			StartedAt:      now.Add(-time.Hour),
			LastActivityAt: now.Add(-30 * time.Minute),
			FirstPrompt:    strp("index importer sessions"),
		},
		Role:    "user",
		Snippet: "add a local «sqlite» store for session metadata and FTS",
	}}

	var b bytes.Buffer
	err := SearchHitsWithOptions(&b, hits, now, SearchOptions{Interactive: true, Width: 96})
	require.NoError(t, err)
	out := b.String()

	require.Contains(t, out, "│")
	require.Contains(t, out, "codex-2026-")
	require.Contains(t, out, "prosa")
	require.Contains(t, out, "codex")
	require.Contains(t, out, "laptop")
	require.Contains(t, out, "user")
	require.Contains(t, out, "sqlite")
	require.Contains(t, out, "session")
	require.Contains(t, out, `"index importer sessions"`)
	require.Contains(t, out, "1 matches")
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
