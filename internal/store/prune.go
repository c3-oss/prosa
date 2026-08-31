package store

import (
	"context"
	"fmt"
	"time"
)

// RecordPushed marks the server-confirmed push state for a session. Plain
// UPDATE, not upsert: the sync_state row is created by WriteSession, so a
// missing row means the session was never imported and there is nothing to
// mark. An empty remoteURI keeps the previously recorded one (the server
// omits raw_uri on idempotent skips).
func (s *Store) RecordPushed(ctx context.Context, sessionID, pushedHash, remoteURI string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sync_state SET
			pushed_at   = ?,
			pushed_hash = ?,
			remote_uri  = COALESCE(NULLIF(?, ''), remote_uri)
		WHERE session_id = ?
	`, formatTime(time.Now()), pushedHash, remoteURI, sessionID)
	if err != nil {
		return fmt.Errorf("record pushed %s: %w", sessionID, err)
	}
	return nil
}

// RecordPushedBatch backfills pushed state for sessions the server manifest
// confirmed holding with the given hashes. One transaction; remote_uri is
// left untouched (the manifest does not carry it).
func (s *Store) RecordPushedBatch(ctx context.Context, hashes map[string]string) error {
	if len(hashes) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	now := formatTime(time.Now())
	for id, hash := range hashes {
		if _, err := tx.ExecContext(ctx, `
			UPDATE sync_state SET pushed_at = ?, pushed_hash = ?
			WHERE session_id = ?
		`, now, hash, id); err != nil {
			return fmt.Errorf("record pushed %s: %w", id, err)
		}
	}
	return tx.Commit()
}

// PruneCandidate is one session eligible for local raw pruning: pushed to
// the server with the current raw_hash, not yet pruned, and inactive for
// longer than the caller's cutoff.
type PruneCandidate struct {
	ID             string
	Agent          string
	RawPath        string
	RawHash        string
	RawSize        int64
	LastActivityAt time.Time
}

// ListPruneCandidates returns prunable sessions for a device: not pruned,
// server-confirmed push of the current raw_hash, and last activity before
// the cutoff. Ordered oldest activity first; limit <= 0 returns all.
func (s *Store) ListPruneCandidates(ctx context.Context, deviceID string, before time.Time, limit int) ([]PruneCandidate, error) {
	q := `
		SELECT s.id, s.agent, s.raw_path, s.raw_hash, s.raw_size, s.last_activity_at
		FROM sessions s
		JOIN sync_state ss ON ss.session_id = s.id
		WHERE s.device_id = ?
		  AND s.pruned_at IS NULL
		  AND ss.pushed_hash = s.raw_hash
		  AND s.last_activity_at < ?
		ORDER BY s.last_activity_at ASC`
	args := []any{deviceID, formatTime(before)}
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PruneCandidate
	for rows.Next() {
		var (
			c       PruneCandidate
			lastAct string
		)
		if err := rows.Scan(&c.ID, &c.Agent, &c.RawPath, &c.RawHash, &c.RawSize, &lastAct); err != nil {
			return nil, err
		}
		if t, ok := parseTime(lastAct); ok {
			c.LastActivityAt = t
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MarkPruned flips a session to pruned, guarded by the raw hash observed at
// candidate time and by not being pruned already. Returns false when the
// guard failed (raw changed or a concurrent prune won) — the caller must
// then leave the file alone.
func (s *Store) MarkPruned(ctx context.Context, sessionID, rawHash string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE sessions SET pruned_at = ?
		WHERE id = ? AND raw_hash = ? AND pruned_at IS NULL
	`, formatTime(time.Now()), sessionID, rawHash)
	if err != nil {
		return false, fmt.Errorf("mark pruned %s: %w", sessionID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ClearPruned reverts MarkPruned when the raw file deletion failed and the
// local copy is still intact.
func (s *Store) ClearPruned(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET pruned_at = NULL WHERE id = ?`, sessionID)
	if err != nil {
		return fmt.Errorf("clear pruned %s: %w", sessionID, err)
	}
	return nil
}

// PruneAdvisory counts prunable sessions and their raw bytes for the sync
// summary: not pruned, pushed hash matches, pushed before pushedBefore, and
// last activity before before. Purely local, so the advisory also works
// offline.
func (s *Store) PruneAdvisory(ctx context.Context, deviceID string, before, pushedBefore time.Time) (int, int64, error) {
	var (
		count int
		bytes int64
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(s.raw_size), 0)
		FROM sessions s
		JOIN sync_state ss ON ss.session_id = s.id
		WHERE s.device_id = ?
		  AND s.pruned_at IS NULL
		  AND ss.pushed_hash = s.raw_hash
		  AND ss.pushed_at < ?
		  AND s.last_activity_at < ?
	`, deviceID, formatTime(pushedBefore), formatTime(before)).Scan(&count, &bytes)
	if err != nil {
		return 0, 0, fmt.Errorf("prune advisory: %w", err)
	}
	return count, bytes, nil
}
