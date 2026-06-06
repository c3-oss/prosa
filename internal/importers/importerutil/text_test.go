package importerutil

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseRFC3339(t *testing.T) {
	got, ok := ParseRFC3339("2026-01-02T03:04:05.123456789-03:00")
	require.True(t, ok)
	require.Equal(t, time.Date(2026, 1, 2, 6, 4, 5, 123456789, time.UTC), got)

	_, ok = ParseRFC3339("not a time")
	require.False(t, ok)
}

func TestTruncatePreview(t *testing.T) {
	lines := make([]string, ToolPreviewMaxLines+2)
	for i := range lines {
		lines[i] = "line"
	}
	got := TruncatePreview(strings.Join(lines, "\n"))
	require.True(t, strings.HasSuffix(got, "\n…"))
	require.Len(t, strings.Split(strings.TrimSuffix(got, "\n…"), "\n"), ToolPreviewMaxLines)
}

func TestTruncatePreviewPreservesUTF8(t *testing.T) {
	body := strings.Repeat("a", ToolPreviewMaxBytes-1) + "é suffix"
	got := TruncatePreview(body)
	require.True(t, strings.HasSuffix(got, "\n…"))
	require.True(t, strings.HasSuffix(strings.TrimSuffix(got, "\n…"), "a"))
}
