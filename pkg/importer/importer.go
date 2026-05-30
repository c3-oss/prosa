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
	Import(ctx context.Context, jsonlPath string, sink Sink) (ImportResult, error)
}

// Sink absorbs the projection produced by an importer. The store package
// implements this directly; tests substitute in-memory fakes.
type Sink interface {
	UpsertSession(ctx context.Context, s session.Session, tools []session.ToolUsage) error
	InsertTurns(ctx context.Context, sessionID string, turns []session.Turn) error
	LastHash(ctx context.Context, sessionID string) (string, bool, error)
	RecordSync(ctx context.Context, sessionID, hash string) error
}
