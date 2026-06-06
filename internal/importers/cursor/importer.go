// Package cursor implements the prosa importer for Cursor "agent" chats
// preserved as SQLite databases under ~/.cursor/chats/<workspace>/<agent>/
// store.db. See docs/canonical-session.md for the canonical projection
// contract and docs/sources/legacy-bundle.md for how legacy ~/.prosa raw
// bundles surface these `.db` files into the same code path.
package cursor

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "cursor"

// Importer satisfies importer.Importer for Cursor.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".cursor", "chats")}
}

// Import opens the Cursor store.db read-only, parses meta + blobs into a
// canonical session, and preserves the .db bytes verbatim. Idempotency is
// keyed on the file's sha256 (identical to claudecode/codex), so re-running
// against the same store skips the parse and re-write (bypassed when
// opts.Overwrite is set).
//
// Cursor sessions always come back with UsageStateUnknown — the
// store.db has no per-message token field — and the policy classifier
// admits them; they show up in sessions/projects/heatmap/tools but
// contribute zero rows to the cost panel.
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
	})
}
