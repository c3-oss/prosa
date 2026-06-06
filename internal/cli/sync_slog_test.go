package cli

import (
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWarningCounterHandlerCountsWarningsOnly(t *testing.T) {
	var count atomic.Int64
	logger := slog.New(warningCounterHandler{count: &count})

	logger.Info("ignored")
	logger.Warn("counted")
	logger.Error("counted")

	require.Equal(t, int64(2), count.Load())
}

func TestSyncSummaryTTYShowsSuppressedWarnings(t *testing.T) {
	counts := &syncCounts{suppressedWarnings: 2}

	out := captureStdout(t, counts.printSummaryTTY)

	require.Contains(t, out, "Warnings")
	require.Contains(t, out, "2 diagnostic logs suppressed in TTY")
	require.Contains(t, out, "--verbose")
}

func TestSuppressedWarningsTextSingular(t *testing.T) {
	got := suppressedWarningsText(1)

	require.True(t, strings.Contains(got, "1 diagnostic log suppressed"))
	require.True(t, strings.Contains(got, "see it"))
}
