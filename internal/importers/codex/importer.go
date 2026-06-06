// Package codex implements the prosa importer for Codex CLI session
// JSONL transcripts stored under ~/.codex/sessions/<YYYY>/<MM>/<DD>/
// rollout-*.jsonl. See docs/canonical-session.md for how each Codex
// record projects into session.Session / Turn / ToolUsage and
// docs/sources/codex.md for the envelope vs. legacy record shapes the
// parser handles.
package codex

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "codex"

// Importer satisfies importer.Importer for Codex.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration in cut 2.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".codex", "sessions")}
}

// Import is the per-file entry point used by the CLI sync command. The
// pipeline mirrors claudecode.Import — hash, peek id, idempotency
// short-circuit (bypassed when opts.Overwrite is set), parse, classify
// usage, preserve raw, write through Sink — so the diff between agents
// stays inside parse.go and walk.go.
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
