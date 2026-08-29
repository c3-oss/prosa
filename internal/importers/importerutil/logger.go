package importerutil

import (
	"log/slog"

	"github.com/c3-oss/prosa/pkg/importer"
)

// Logger returns the logger an import's diagnostics belong on. Importers
// never reach for package-level slog: the caller decides where warnings
// land, so the interactive sync path can tally them instead of writing
// into its own progress frame.
func Logger(opts importer.ImportOptions) *slog.Logger {
	if opts.Logger != nil {
		return opts.Logger
	}
	return slog.Default()
}
