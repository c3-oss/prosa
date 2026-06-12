// Package claudecode implements the prosa importer for Claude Code JSONL
// transcripts stored under ~/.claude/projects/. See docs/canonical-session.md
// for how each JSONL record type projects into session.Session / Turn /
// ToolUsage.
package claudecode

import (
	"context"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "claude-code"

// Importer satisfies importer.Importer for Claude Code.
type Importer struct{}

// New returns a zero-state importer.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := paths.UserHome()
	if err != nil {
		return nil
	}
	return i.RootsUnder(filepath.Join(home, ".claude"))
}

func (i *Importer) RootsUnder(base string) []string {
	return []string{filepath.Join(base, "projects")}
}

// Import is the per-file entry point used by the CLI sync command.
func (i *Importer) Import(ctx context.Context, jsonlPath string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	return importerutil.RunSingleFile(ctx, importerutil.SingleFileConfig{
		Agent:  Name,
		Path:   jsonlPath,
		Sink:   sink,
		Opts:   opts,
		Hash:   importerutil.HashAndSize,
		PeekID: peekSessionID,
		Parse:  parseSession,
		PreserveRaw: func(srcPath, sessionID string, startedAt time.Time) (string, error) {
			return importerutil.PreserveRaw(Name, sessionID, ".jsonl", startedAt, srcPath)
		},
	})
}
