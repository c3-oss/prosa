package cli

import (
	"bytes"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/c3-oss/prosa/pkg/importer"
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

	stdout, stderr := captureStdoutStderr(t, counts.printSummaryTTY)

	require.Empty(t, stdout)
	require.Contains(t, stderr, "Warnings")
	require.Contains(t, stderr, "2 diagnostic logs suppressed in TTY")
	require.Contains(t, stderr, "--verbose")
}

func TestSuppressedWarningsTextSingular(t *testing.T) {
	got := suppressedWarningsText(1)

	require.True(t, strings.Contains(got, "1 diagnostic log suppressed"))
	require.True(t, strings.Contains(got, "see it"))
}

// TestQuietSyncLoggingScopesImporterWarnings asserts the interactive path
// routes importer diagnostics into the same counter the pusher uses, so
// the summary's Warnings row covers both phases — and that nothing leaks
// onto the process-global slog default, which issue #154 took out of this
// code path for good.
func TestQuietSyncLoggingScopesImporterWarnings(t *testing.T) {
	var global bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&global, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	var count atomic.Int64
	push := &pusher{}
	got := quietSyncLogging(importer.ImportOptions{Overwrite: true, Profile: "mz"}, push, &count)

	require.NotNil(t, got.Logger)
	require.Same(t, got.Logger, push.logger, "one counter must feed both phases")
	require.True(t, got.Overwrite, "the value copy must preserve the rest of opts")
	require.Equal(t, "mz", got.Profile)

	got.Logger.Warn("codex: malformed JSONL lines skipped", "count", 2)
	push.log().Warn("reconcile: catching up")

	require.Equal(t, int64(2), count.Load())
	require.Empty(t, global.String(), "sync diagnostics must not reach the global slog default")
}

// TestQuietSyncLoggingWithoutPusher covers the server-less sync (no
// auth.json): importers still get the scoped logger.
func TestQuietSyncLoggingWithoutPusher(t *testing.T) {
	var count atomic.Int64
	got := quietSyncLogging(importer.ImportOptions{}, nil, &count)

	require.NotNil(t, got.Logger)
	got.Logger.Warn("counted")
	require.Equal(t, int64(1), count.Load())
}
