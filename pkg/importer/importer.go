// Package importer defines the plugin contract every per-agent connector
// implements to turn JSONL (or other) transcripts into canonical sessions.
//
// One implementation lives in internal/importers/<agent>/. The CLI (sync
// command) discovers importers by name and drives Walk + Import + Sink.
// Tests use in-memory Sink fakes; the production Sink is internal/store.Store.
package importer

import (
	"context"

	"github.com/c3-oss/prosa/pkg/session"
)

// Source pairs an agent name with the filesystem root being scanned.
type Source struct {
	Agent string
	Root  string
}

// ImportResult is the per-file outcome. Skipped == true means the file's
// sha256 matched the recorded sync_state and the import short-circuited
// without parsing or rewriting the raw copy.
type ImportResult struct {
	SessionID string
	RawPath   string
	RawHash   string
	RawSize   int64
	Skipped   bool
	// SkipReason optionally distinguishes hash-idempotent skips from
	// policy skips such as transcripts with no measured token usage.
	SkipReason string
	// Synthetic marks SessionID as an idempotency marker rather than a real
	// session row in the store (e.g. hermes state.db's
	// "hermes-state-<hash>"). Multi-session importers set this; the CLI must
	// not inline-push it — the imported sessions converge via the catch-up
	// reconcile phase. Skipped results never need this (push is already gated
	// on !Skipped); it matters only for non-skipped multi-session imports.
	Synthetic bool
}

// ImportOptions tunes a single Import call. Zero value is standard idempotent behaviour.
type ImportOptions struct {
	// Overwrite forces re-parse and re-upsert even when the file's hash
	// is already in sync_state or the file has a matching import skip
	// record. Used by `prosa sync --overwrite` to rebuild a converged store
	// from raw transcripts.
	Overwrite bool
}

// Importer is the plugin contract every per-agent connector implements.
type Importer interface {
	// Name identifies the agent (e.g. "claude-code").
	Name() string

	// DefaultRoots are filesystem locations checked when the user doesn't
	// override via flag. May return an empty slice if home dir is
	// unresolvable.
	DefaultRoots() []string

	// Walk discovers session files under root.
	Walk(ctx context.Context, root string) ([]string, error)

	// Import parses a single JSONL file and writes the projection through sink.
	Import(ctx context.Context, jsonlPath string, sink Sink, opts ImportOptions) (ImportResult, error)
}

// Sink absorbs the projection produced by an importer.
//
// WriteSession is atomic: session row, usage, tools, turns, and sync_state
// hash land in one transaction so a crash mid-import can never leave a
// partial session. LastHash is read before parsing to short-circuit
// re-imports of unchanged files.
type Sink interface {
	WriteSession(ctx context.Context, s session.Session, tools []session.ToolUsage, turns []session.Turn, hash string) error
	LastHash(ctx context.Context, sessionID string) (string, bool, error)
}

const (
	SkipReasonNoUsage   = "no_usage"
	SkipReasonStateSeen = "state_seen"
)

// SkipCache is an optional Sink extension that remembers policy-skipped files
// by hash even when no session row exists. sessionID may be a real session id
// or a synthetic marker depending on the skip reason.
type SkipCache interface {
	LastImportSkip(ctx context.Context, sessionID, reason string) (string, bool, error)
	RecordImportSkip(ctx context.Context, sessionID, hash, reason string) error
}

func PreviouslySkipped(ctx context.Context, sink Sink, sessionID, hash, reason string) (bool, error) {
	cache, ok := sink.(SkipCache)
	if !ok {
		return false, nil
	}
	prev, found, err := cache.LastImportSkip(ctx, sessionID, reason)
	if err != nil || !found {
		return false, err
	}
	return prev == hash, nil
}

func RecordSkip(ctx context.Context, sink Sink, sessionID, hash, reason string) error {
	cache, ok := sink.(SkipCache)
	if !ok {
		return nil
	}
	return cache.RecordImportSkip(ctx, sessionID, hash, reason)
}
