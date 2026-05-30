package render

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/store"
)

func TestAnalyticsTTYEmptyState(t *testing.T) {
	var b bytes.Buffer
	err := Analytics(&b, store.AnalyticsResult{Headers: []string{"AGENT", "SESSIONS"}}, true)
	require.NoError(t, err)
	require.Equal(t, "no rows\n", b.String())
}

func TestAnalyticsPlainHasNoANSI(t *testing.T) {
	var b bytes.Buffer
	err := Analytics(&b, store.AnalyticsResult{
		Headers: []string{"AGENT", "SESSIONS"},
		Rows: []store.AnalyticsRow{
			{Values: []any{"codex", "2"}},
		},
	}, false)
	require.NoError(t, err)
	out := b.String()

	require.Equal(t, "AGENT\tSESSIONS\ncodex\t2\n", out)
	require.False(t, strings.Contains(out, "\x1b["), "plain output must not contain ANSI escapes")
}
