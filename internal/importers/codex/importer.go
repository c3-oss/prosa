// Package codex implements the prosa importer for Codex CLI session
// JSONL transcripts stored under ~/.codex/sessions/<YYYY>/<MM>/<DD>/
// rollout-*.jsonl. See docs/canonical-session.md for how each Codex
// record projects into session.Session / Turn / ToolUsage and
// docs/sources/codex.md for the envelope vs. legacy record shapes the
// parser handles.
package codex

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
	hash, size, err := hashAndSize(jsonlPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", jsonlPath, err)
	}

	sessionID, err := peekSessionID(jsonlPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("peek session id %s: %w", jsonlPath, err)
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

	sess, turns, tools, usageState, err := parseSession(ctx, jsonlPath)
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
	if importpolicy.ClassifyForImport(usageState) == importpolicy.DecisionSkipNoUsage {
		return importpolicy.RecordNoUsageSkip(ctx, sink, sessionID, hash, size)
	}

	rawPath, err := preserveRaw(jsonlPath, sessionID, sess.StartedAt)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", jsonlPath, err)
	}
	sess.RawPath = rawPath
	projectid.Apply(&sess)

	if err := sink.WriteSession(ctx, sess, tools, turns, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("write session %s: %w", sessionID, err)
	}

	return importer.ImportResult{
		SessionID: sessionID,
		RawPath:   rawPath,
		RawHash:   hash,
		RawSize:   size,
		Skipped:   false,
	}, nil
}
