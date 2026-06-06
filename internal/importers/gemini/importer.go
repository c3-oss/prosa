// Package gemini implements the prosa importer for Gemini CLI chat
// histories preserved under ~/.gemini/tmp/<projectHash>/. Two shapes are
// supported:
//
//   - Legacy bundle: chats/session-*.json — one envelope object per file
//     with {sessionId, projectHash, startTime, messages: [...]}.
//   - Live: logs.json — an array of standalone records with sessionId
//     per row. The importer projects the dominant session per file.
//
// See docs/canonical-session.md for the canonical contract and
// docs/sources/legacy-bundle.md for how the legacy bundle path feeds the
// same code.
package gemini

import (
	"context"
	"os"
	"path/filepath"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "gemini"

// Importer satisfies importer.Importer for Gemini.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".gemini", "tmp")}
}

// Import is the per-file entry point. Same flow as claudecode/codex —
// hash, peek id, idempotency (bypassed when opts.Overwrite is set),
// parse, classify usage, preserve raw, sink writes.
func (i *Importer) Import(ctx context.Context, jsonPath string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	return importerutil.RunSingleFile(ctx, importerutil.SingleFileConfig{
		Agent:              Name,
		Path:               jsonPath,
		Sink:               sink,
		Opts:               opts,
		Hash:               hashAndSize,
		PeekID:             peekSessionID,
		Parse:              parseSession,
		PreserveRaw:        preserveRaw,
		UseParsedSessionID: true,
	})
}
