// Package cursor implements the prosa importer for Cursor "agent" chats
// preserved as SQLite databases under ~/.cursor/chats/<workspace>/<agent>/
// store.db. See docs/canonical-session.md for the canonical projection
// contract and docs/sources/legacy-bundle.md for how legacy ~/.prosa raw
// bundles surface these `.db` files into the same code path.
package cursor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/importpolicy"
	"github.com/c3-oss/prosa/internal/projectid"
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
	hash, size, err := hashAndSize(dbPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", dbPath, err)
	}

	sessionID, err := peekSessionID(dbPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("peek session id %s: %w", dbPath, err)
	}

	if !opts.Overwrite {
		if prev, found, err := sink.LastHash(ctx, sessionID); err == nil && found && prev == hash {
			return importer.ImportResult{
				SessionID: sessionID,
				RawHash:   hash,
				RawSize:   size,
				Skipped:   true,
			}, nil
		}
		if res, ok, err := importpolicy.PreviouslySkippedNoUsage(ctx, sink, sessionID, hash, size); err != nil {
			return importer.ImportResult{}, fmt.Errorf("read import skip %s: %w", sessionID, err)
		} else if ok {
			return res, nil
		}
	}

	sess, turns, tools, usageState, err := parseSession(ctx, dbPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("parse %s: %w", dbPath, err)
	}
	if sess.ID == "" {
		sess.ID = sessionID
	}
	sess.Agent = Name
	sess.DeviceID = device.IDOnce()
	sess.RawHash = hash
	sess.RawSize = size
	if importpolicy.ClassifyForImport(usageState) == importpolicy.DecisionSkipNoUsage {
		return importpolicy.RecordNoUsageSkip(ctx, sink, sessionID, hash, size)
	}

	rawPath, err := preserveRaw(dbPath, sessionID, sess.StartedAt)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", dbPath, err)
	}
	sess.RawPath = rawPath
	projectid.Apply(&sess)

	if err := sink.UpsertSession(ctx, sess, tools); err != nil {
		return importer.ImportResult{}, fmt.Errorf("upsert session %s: %w", sessionID, err)
	}
	if err := sink.InsertTurns(ctx, sessionID, turns); err != nil {
		return importer.ImportResult{}, fmt.Errorf("insert turns %s: %w", sessionID, err)
	}
	if err := sink.RecordSync(ctx, sessionID, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("record sync %s: %w", sessionID, err)
	}

	return importer.ImportResult{
		SessionID: sessionID,
		RawPath:   rawPath,
		RawHash:   hash,
		RawSize:   size,
		Skipped:   false,
	}, nil
}
