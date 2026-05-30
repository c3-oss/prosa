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
	"fmt"
	"os"
	"path/filepath"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/projectid"
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
// hash, peek id, idempotency, parse, preserve raw, sink writes.
func (i *Importer) Import(ctx context.Context, jsonPath string, sink importer.Sink) (importer.ImportResult, error) {
	hash, size, err := hashAndSize(jsonPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", jsonPath, err)
	}

	sessionID, err := peekSessionID(jsonPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("peek session id %s: %w", jsonPath, err)
	}

	if prev, found, err := sink.LastHash(ctx, sessionID); err == nil && found && prev == hash {
		return importer.ImportResult{
			SessionID: sessionID,
			RawHash:   hash,
			RawSize:   size,
			Skipped:   true,
		}, nil
	}

	sess, turns, tools, err := parseSession(ctx, jsonPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("parse %s: %w", jsonPath, err)
	}
	if sess.ID == "" {
		sess.ID = sessionID
	}
	sess.Agent = Name
	sess.DeviceID = device.IDOnce()
	sess.RawHash = hash
	sess.RawSize = size

	rawPath, err := preserveRaw(jsonPath, sess.ID, sess.StartedAt)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", jsonPath, err)
	}
	sess.RawPath = rawPath
	projectid.Apply(&sess)

	if err := sink.UpsertSession(ctx, sess, tools); err != nil {
		return importer.ImportResult{}, fmt.Errorf("upsert session %s: %w", sess.ID, err)
	}
	if err := sink.InsertTurns(ctx, sess.ID, turns); err != nil {
		return importer.ImportResult{}, fmt.Errorf("insert turns %s: %w", sess.ID, err)
	}
	if err := sink.RecordSync(ctx, sess.ID, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("record sync %s: %w", sess.ID, err)
	}

	return importer.ImportResult{
		SessionID: sess.ID,
		RawPath:   rawPath,
		RawHash:   hash,
		RawSize:   size,
		Skipped:   false,
	}, nil
}
