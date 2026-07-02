package render

import (
	"bytes"
	"strings"
	"testing"
	"time"

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

func TestFormatCostHumanizesDollars(t *testing.T) {
	t.Parallel()

	require.Equal(t, "$2,192.29", formatCost("2192.2861"))
	require.Equal(t, "$341.19", formatCost("341.1885"))
	require.Equal(t, "$0.00", formatCost("0"))
	require.Equal(t, "n/a", formatCost(""))
	require.Equal(t, "$oops", formatCost("oops"))
}

func TestDisplayTimestampLocalWallClock(t *testing.T) {
	t.Parallel()

	in := "2026-07-01T19:23:53.698Z"
	want := time.Date(2026, 7, 1, 19, 23, 53, 0, time.UTC).Local().Format("2006-01-02 15:04")
	require.Equal(t, want, displayTimestamp(in))
	require.Equal(t, "not-a-time", displayTimestamp("not-a-time"))
}

func TestDisplayProjectCollapsesRemotesKeepsPaths(t *testing.T) {
	t.Parallel()

	require.Equal(t, "mz-codes/mz-operator-1", displayProject("git@github.com:mz-codes/mz-operator-1.git"))
	require.Equal(t, "(unscoped)", displayProject("(unscoped)"))
	require.Equal(t, "/opt/work", displayProject("/opt/work"))
}

func TestFormatNumericText(t *testing.T) {
	t.Parallel()

	require.Equal(t, "25,400", formatNumericText("25400"))
	require.Equal(t, "7", formatNumericText("7"))
	require.Equal(t, "-", formatNumericText("-"))
}
