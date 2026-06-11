// Package antigravity implements the prosa importer for the Antigravity
// CLI (Google's `agy`, the successor to Gemini CLI). Each conversation
// is stored as one SQLite database under
// ~/.gemini/antigravity-cli/conversations/<conversation-uuid>.db with
// step payloads in undocumented protobuf wire format — see proto.go
// for the reverse-engineered field map.
//
// The legacy `gemini` importer continues to handle Gemini CLI JSONL
// histories under ~/.gemini/tmp/.
package antigravity

import (
	"context"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "antigravity"

// Importer satisfies importer.Importer for Antigravity CLI.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := paths.UserHome()
	if err != nil {
		return nil
	}
	return i.RootsUnder(filepath.Join(home, ".gemini"))
}

// RootsUnder scans <base>/antigravity-cli/conversations. Shares the ~/.gemini
// base with the gemini importer, but appends its own subpath.
func (i *Importer) RootsUnder(base string) []string {
	return []string{filepath.Join(base, "antigravity-cli", "conversations")}
}

// Import is the per-file entry point called by the compile pipeline.
func (i *Importer) Import(ctx context.Context, dbPath string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	return importerutil.RunSingleFile(ctx, importerutil.SingleFileConfig{
		Agent:  Name,
		Path:   dbPath,
		Sink:   sink,
		Opts:   opts,
		Hash:   importerutil.HashAndSize,
		PeekID: peekSessionID,
		Parse:  parseSession,
		PreserveRaw: func(srcPath, sessionID string, startedAt time.Time) (string, error) {
			return importerutil.PreserveRaw(Name, sessionID, ".db", startedAt, srcPath)
		},
		UseParsedSessionID: true,
	})
}
