// Package hermes implements the prosa importer for Hermes CLI session
// histories preserved under ~/.hermes/. Three shapes are supported:
//
//   - state.db at <hermes-home>/state.db — SQLite database with
//     `sessions` and `messages` tables. One file, many sessions.
//   - <id>.jsonl at <hermes-home>/sessions/ — per-session JSONL transcript
//     where the session id is the filename stem.
//   - session_<id>.json at <hermes-home>/sessions/ — per-session JSON
//     snapshot envelope carrying {session_id, session_start, messages}.
//
// See docs/canonical-session.md for the canonical projection contract and
// docs/sources/hermes.md for the three shapes and how state.db's per-session
// rows defer to a fuller sibling transcript when one exists.
package hermes

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/importers/importpolicy"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/projectid"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "hermes"

// Importer satisfies importer.Importer for Hermes.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := paths.UserHome()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".hermes", "sessions")}
}

// Import dispatches on the source path's basename + extension. state.db
// is the SQLite multi-session store; .jsonl files are per-session
// transcripts; session_*.json files are per-session snapshots. Anything
// else is rejected — Walk() only yields these three shapes, so a bad
// path here means a caller fed us something unsupported.
func (i *Importer) Import(ctx context.Context, path string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	base := filepath.Base(path)
	ext := filepath.Ext(path)

	switch {
	case base == "state.db":
		return i.importStateDB(ctx, path, sink, opts)
	case ext == ".jsonl":
		return i.importJSONL(ctx, path, sink, opts)
	case ext == ".json" && len(base) > len("session_") && base[:len("session_")] == "session_":
		return i.importSnapshot(ctx, path, sink, opts)
	default:
		return importer.ImportResult{}, fmt.Errorf("unsupported hermes path: %s", path)
	}
}

// importJSONL handles the per-session .jsonl transcript. The session id is
// the filename stem; idempotency is keyed on that id (bypassed when
// opts.Overwrite is set).
func (i *Importer) importJSONL(ctx context.Context, path string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	return importerutil.RunSingleFile(ctx, importerutil.SingleFileConfig{
		Agent: Name,
		Path:  path,
		Sink:  sink,
		Opts:  opts,
		Hash:  importerutil.HashAndSize,
		PeekID: func(path string) (string, error) {
			return stripExt(filepath.Base(path)), nil
		},
		Parse: parseJSONL,
		PreserveRaw: func(srcPath, sessionID string, startedAt time.Time) (string, error) {
			return importerutil.PreserveRaw(Name, sessionID, ".jsonl", startedAt, srcPath)
		},
	})
}

// importSnapshot handles a session_<id>.json envelope. The id comes from
// the `session_id` field with the filename-stem fallback.
func (i *Importer) importSnapshot(ctx context.Context, path string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	return importerutil.RunSingleFile(ctx, importerutil.SingleFileConfig{
		Agent:              Name,
		Path:               path,
		Sink:               sink,
		Opts:               opts,
		Hash:               importerutil.HashAndSize,
		PeekID:             peekSnapshotID,
		Parse:              parseSnapshot,
		UseParsedSessionID: true,
		PreserveRaw: func(srcPath, sessionID string, startedAt time.Time) (string, error) {
			return importerutil.PreserveRaw(Name, sessionID, ".json", startedAt, srcPath)
		},
	})
}

// importStateDB iterates every session row in state.db and upserts each
// one. Idempotency is layered: a synthetic "hermes-state-<hash[:12]>" id
// short-circuits the whole file when the bytes are unchanged (bypassed
// when opts.Overwrite is set); per-session rows that have a fuller
// sibling .jsonl/.json transcript are skipped so the dedicated file-
// shaped Import call wins.
func (i *Importer) importStateDB(ctx context.Context, path string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	hash, size, err := importerutil.HashAndSize(path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", path, err)
	}
	synthetic := "hermes-state-" + hash[:12]

	if !opts.Overwrite {
		seen, err := importer.PreviouslySkipped(ctx, sink, synthetic, hash, importer.SkipReasonStateSeen)
		if err != nil {
			return importer.ImportResult{}, fmt.Errorf("read state seen %s: %w", synthetic, err)
		}
		if seen {
			return importer.ImportResult{
				SessionID: synthetic,
				RawHash:   hash,
				RawSize:   size,
				Skipped:   true,
			}, nil
		}
		if res, ok, err := importpolicy.PreviouslySkippedNoUsage(ctx, sink, synthetic, hash, size); err != nil {
			return importer.ImportResult{}, fmt.Errorf("read import skip %s: %w", synthetic, err)
		} else if ok {
			return res, nil
		}
	}

	rows, err := readStateDBSessions(ctx, path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("read state.db %s: %w", path, err)
	}

	siblingDir := filepath.Join(filepath.Dir(path), "sessions")
	imported := 0
	noUsageSkipped := 0
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return importer.ImportResult{}, err
		}
		if siblingHasMore(siblingDir, row.id, row.messageCount) {
			continue
		}
		sess, turns, tools, usageState, err := projectStateDBSession(ctx, path, row)
		if err != nil {
			return importer.ImportResult{}, fmt.Errorf("project session %s: %w", row.id, err)
		}
		if importpolicy.ClassifyForImport(usageState) == importpolicy.DecisionSkipNoUsage {
			if _, err := importpolicy.RecordNoUsageSkip(ctx, sink, row.id, hash, size); err != nil {
				return importer.ImportResult{}, fmt.Errorf("record import skip %s: %w", row.id, err)
			}
			noUsageSkipped++
			continue
		}
		sess.Agent = Name
		sess.DeviceID = device.IDOnce()
		sess.RawHash = hash
		sess.RawSize = size

		rawPath, err := importerutil.PreserveRaw(Name, row.id, ".db", sess.StartedAt, path)
		if err != nil {
			return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", path, err)
		}
		sess.RawPath = rawPath
		projectid.Apply(&sess)

		if err := sink.WriteSession(ctx, sess, tools, turns, hash); err != nil {
			return importer.ImportResult{}, fmt.Errorf("write session %s: %w", row.id, err)
		}
		imported++
	}

	if err := importer.RecordSkip(ctx, sink, synthetic, hash, importer.SkipReasonStateSeen); err != nil {
		return importer.ImportResult{}, fmt.Errorf("record state seen %s: %w", synthetic, err)
	}
	if imported == 0 && noUsageSkipped > 0 {
		return importpolicy.ImportSkippedNoUsageResult(synthetic, hash, size), nil
	}

	return importer.ImportResult{
		SessionID: synthetic,
		RawHash:   hash,
		RawSize:   size,
		Skipped:   false,
	}, nil
}

// stripExt returns the filename without its final extension.
func stripExt(name string) string {
	ext := filepath.Ext(name)
	return name[:len(name)-len(ext)]
}
