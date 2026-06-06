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
	"fmt"
	"os"
	"path/filepath"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/importpolicy"
	"github.com/c3-oss/prosa/internal/projectid"
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
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".gemini", "antigravity-cli", "conversations")}
}

// Import is the per-file entry point. Same flow as the other importers:
// hash → peek id → idempotency (bypassed when opts.Overwrite is set) →
// parse → classify usage → preserve raw → projectid.Apply → sink writes.
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
		return importpolicy.RecordNoUsageSkip(ctx, sink, sess.ID, hash, size)
	}

	rawPath, err := preserveRaw(dbPath, sess.ID, sess.StartedAt)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", dbPath, err)
	}
	sess.RawPath = rawPath
	projectid.Apply(&sess)

	if err := sink.WriteSession(ctx, sess, tools, turns, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("write session %s: %w", sess.ID, err)
	}

	return importer.ImportResult{
		SessionID: sess.ID,
		RawPath:   rawPath,
		RawHash:   hash,
		RawSize:   size,
		Skipped:   false,
	}, nil
}
