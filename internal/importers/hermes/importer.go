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
	"os"
	"path/filepath"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/importpolicy"
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
	home, err := os.UserHomeDir()
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
	hash, size, err := hashAndSize(path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", path, err)
	}

	sessionID := stripExt(filepath.Base(path))

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

	sess, turns, tools, usageState, err := parseJSONL(ctx, path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("parse %s: %w", path, err)
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

	rawPath, err := preserveRaw(path, sessionID, sess.StartedAt, ".jsonl")
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", path, err)
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

// importSnapshot handles a session_<id>.json envelope. The id comes from
// the `session_id` field with the filename-stem fallback.
func (i *Importer) importSnapshot(ctx context.Context, path string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	hash, size, err := hashAndSize(path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", path, err)
	}

	sessionID, err := peekSnapshotID(path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("peek session id %s: %w", path, err)
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

	sess, turns, tools, usageState, err := parseSnapshot(ctx, path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("parse %s: %w", path, err)
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

	rawPath, err := preserveRaw(path, sess.ID, sess.StartedAt, ".json")
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", path, err)
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

// importStateDB iterates every session row in state.db and upserts each
// one. Idempotency is layered: a synthetic "hermes-state-<hash[:12]>" id
// short-circuits the whole file when the bytes are unchanged (bypassed
// when opts.Overwrite is set); per-session rows that have a fuller
// sibling .jsonl/.json transcript are skipped so the dedicated file-
// shaped Import call wins.
func (i *Importer) importStateDB(ctx context.Context, path string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	hash, size, err := hashAndSize(path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", path, err)
	}
	synthetic := "hermes-state-" + hash[:12]

	if !opts.Overwrite {
		if prev, found, err := sink.LastHash(ctx, synthetic); err == nil && found && prev == hash {
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

		rawPath, err := preserveRaw(path, row.id, sess.StartedAt, ".db")
		if err != nil {
			return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", path, err)
		}
		sess.RawPath = rawPath
		projectid.Apply(&sess)

		if err := sink.UpsertSession(ctx, sess, tools); err != nil {
			return importer.ImportResult{}, fmt.Errorf("upsert session %s: %w", row.id, err)
		}
		if err := sink.InsertTurns(ctx, row.id, turns); err != nil {
			return importer.ImportResult{}, fmt.Errorf("insert turns %s: %w", row.id, err)
		}
		if err := sink.RecordSync(ctx, row.id, hash); err != nil {
			return importer.ImportResult{}, fmt.Errorf("record sync %s: %w", row.id, err)
		}
		imported++
	}

	if err := sink.RecordSync(ctx, synthetic, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("record sync %s: %w", synthetic, err)
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
