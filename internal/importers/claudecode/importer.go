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

// New returns a zero-state importer; the type has no configuration in cut 1.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := paths.UserHome()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".claude", "projects")}
}

// Import is the per-file entry point used by the CLI sync command. Steps:
//  1. Hash + stat the source file.
//  2. Peek the sessionId from the first record (cheap, single line read).
//  3. Short-circuit if sync_state already records this hash (skipped
//     when opts.Overwrite is set).
//  4. Stream-parse the file to build Session/Turn/ToolUsage + UsageState.
//  5. Copy raw bytes into the prosa raw tree.
//  6. Write through Sink (upsert + turns + sync_state).
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
