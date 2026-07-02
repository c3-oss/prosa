package render

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func tableFixtureCols() []TableColumn {
	return []TableColumn{
		{Header: "AGENT"},
		{Header: "LOCATION"},
		{Header: "SESSIONS", Right: true},
	}
}

func tableFixtureRows() [][]TableCell {
	return [][]TableCell{
		{Cell("claude-code"), Cell("/home/x/.claude"), {Text: "3172", Style: StyleAccent}},
		{Cell("codex"), {Text: "(not configured)", Style: StyleMuted}, {Text: "9", Style: StyleAccent}},
	}
}

func TestTableInteractiveAlignsHeaderWithRows(t *testing.T) {
	t.Parallel()

	var b bytes.Buffer
	require.NoError(t, Table(&b, tableFixtureCols(), tableFixtureRows(), true))
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	require.Len(t, lines, 3)

	// Styled cells must not shift columns: every LOCATION cell starts at
	// the same rune offset as the LOCATION header.
	headerAt := strings.Index(lines[0], "LOCATION")
	require.Positive(t, headerAt)
	require.Equal(t, headerAt, strings.Index(lines[1], "/home/x/.claude"))
	require.Equal(t, headerAt, strings.Index(lines[2], "(not configured)"))
}

func TestTableInteractiveRightAlignsNumbers(t *testing.T) {
	t.Parallel()

	var b bytes.Buffer
	require.NoError(t, Table(&b, tableFixtureCols(), tableFixtureRows(), true))
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")

	// SESSIONS is right-aligned: all rows end at the same column, with
	// the shorter number padded from the left.
	require.True(t, strings.HasSuffix(lines[1], "3172"))
	require.True(t, strings.HasSuffix(lines[2], "   9"), "short number should be left-padded, got %q", lines[2])
}

func TestTablePlainIsTabSeparatedWithoutANSI(t *testing.T) {
	t.Parallel()

	var b bytes.Buffer
	require.NoError(t, Table(&b, tableFixtureCols(), tableFixtureRows(), false))
	out := b.String()

	require.Equal(t, "AGENT\tLOCATION\tSESSIONS\n"+
		"claude-code\t/home/x/.claude\t3172\n"+
		"codex\t(not configured)\t9\n", out)
	require.NotContains(t, out, "\x1b[")
}
