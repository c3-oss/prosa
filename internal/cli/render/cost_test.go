package render

import (
	"bytes"
	"testing"

	"github.com/c3-oss/prosa/internal/store"
	"github.com/stretchr/testify/require"
)

func TestUsageCostMarkersKeepPlainNumbers(t *testing.T) {
	result := store.AnalyticsResult{Headers: []string{"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD", "COST_STATUS", "PRICED_TOKENS", "UNPRICED_TOKENS"}, Rows: []store.AnalyticsRow{
		{Values: []any{"codex", 1, 1, 100, 100, 0, 0, "1.25", "estimated", 100, 0}},
		{Values: []any{"claude-code", 1, 1, 200, 200, 0, 0, "2.50", "partial", 100, 100}},
	}}
	var tty, plain bytes.Buffer
	require.NoError(t, Analytics(&tty, result, true))
	require.Contains(t, tty.String(), "~$1.25")
	require.Contains(t, tty.String(), "$2.50 (partial)")
	require.NoError(t, Analytics(&plain, result, false))
	require.Contains(t, plain.String(), "1.25\testimated\t100\t0")
	require.Contains(t, plain.String(), "2.50\tpartial\t100\t100")
	require.NotContains(t, plain.String(), "\x1b[")
	require.NotContains(t, plain.String(), "~$")
}
