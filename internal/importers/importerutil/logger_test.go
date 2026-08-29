package importerutil

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/stretchr/testify/require"
)

func TestLoggerFallsBackToDefault(t *testing.T) {
	require.Same(t, slog.Default(), Logger(importer.ImportOptions{}))
}

func TestLoggerPrefersOptsLogger(t *testing.T) {
	var buf bytes.Buffer
	scoped := slog.New(slog.NewTextHandler(&buf, nil))

	got := Logger(importer.ImportOptions{Logger: scoped})
	require.Same(t, scoped, got)

	got.Warn("scoped")
	require.Contains(t, buf.String(), "scoped")
}
