// Package claudecode implements the prosa importer for Claude Code JSONL
// transcripts stored under ~/.claude/projects/. See docs/canonical-session.md
// for how each JSONL record type projects into session.Session / Turn /
// ToolUsage.
package claudecode

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
const Name = "claude-code"

// Importer satisfies importer.Importer for Claude Code.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration in cut 1.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".claude", "projects")}
}

// Import is the per-file entry point used by the CLI sync command. Steps:
//  1. Hash + stat the source file.
//  2. Peek the sessionId from the first record (cheap, single line read).
//  3. Short-circuit if sync_state already records this hash.
//  4. Stream-parse the file to build Session/Turn/ToolUsage.
//  5. Copy raw bytes into the prosa raw tree.
//  6. Write through Sink (upsert + turns + sync_state).
func (i *Importer) Import(ctx context.Context, jsonlPath string, sink importer.Sink) (importer.ImportResult, error) {
	hash, size, err := hashAndSize(jsonlPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", jsonlPath, err)
	}

	sessionID, err := peekSessionID(jsonlPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("peek session id %s: %w", jsonlPath, err)
	}

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

	sess, turns, tools, err := parseSession(ctx, jsonlPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("parse %s: %w", jsonlPath, err)
	}
	if sess.ID == "" {
		sess.ID = sessionID
	}
	sess.Agent = Name
	sess.DeviceID = device.IDOnce()
	sess.RawHash = hash
	sess.RawSize = size
	if !importpolicy.HasUsage(sess) {
		return importpolicy.RecordNoUsageSkip(ctx, sink, sessionID, hash, size)
	}

	rawPath, err := preserveRaw(jsonlPath, sessionID, sess.StartedAt)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", jsonlPath, err)
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
