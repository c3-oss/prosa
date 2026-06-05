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

// Source pairs an agent name with the filesystem root being scanned. The
// CLI uses it to label progress output and to disambiguate concurrent
// walks across agents.
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
}

// ImportOptions tunes a single Import call. Threaded through from the
// CLI's `--overwrite` flag; importers default to standard idempotent
// behaviour when the zero value is passed.
type ImportOptions struct {
	// Overwrite forces re-parse and re-upsert even when the file's hash
	// is already in sync_state or its session id is in the no_usage skip
	// cache. Used by `prosa sync --overwrite` to rebuild a converged
	// store from raw transcripts.
	Overwrite bool
}

// Importer is the plugin contract. New agents implement this and register
// themselves with the CLI sync command.
type Importer interface {
	// Name identifies the agent (e.g. "claude-code").
	Name() string

	// DefaultRoots are filesystem locations checked when the user doesn't
	// override via flag. May return an empty slice if home dir is
	// unresolvable.
	DefaultRoots() []string

	// Walk discovers session files under root. Each returned path is a
	// concrete JSONL file ready for Import.
	Walk(ctx context.Context, root string) ([]string, error)

	// Import parses a single JSONL file, copies the raw bytes into the
	// prosa raw tree, and writes the projection through sink.
	Import(ctx context.Context, jsonlPath string, sink Sink, opts ImportOptions) (ImportResult, error)
}

// Sink absorbs the projection produced by an importer. The store package
// implements this directly; tests substitute in-memory fakes.
type Sink interface {
	UpsertSession(ctx context.Context, s session.Session, tools []session.ToolUsage) error
	InsertTurns(ctx context.Context, sessionID string, turns []session.Turn) error
	LastHash(ctx context.Context, sessionID string) (string, bool, error)
	RecordSync(ctx context.Context, sessionID, hash string) error
}

const (
	SkipReasonNoUsage   = "no_usage"
	SkipReasonStateSeen = "state_seen"
)

// SkipCache is an optional Sink extension. Stores that implement it can
// remember policy-skipped files by hash even when no session row exists.
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
