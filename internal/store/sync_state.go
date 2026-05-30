package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

// LastHash returns the most recently recorded raw hash for a session, or
// (_, false, nil) if the session has never been recorded. Callers compare
// the freshly computed hash to short-circuit reimports of unchanged files.
func (s *Store) LastHash(ctx context.Context, sessionID string) (string, bool, error) {
	var (
		hash              string
		projectionVersion int
	)
	err := s.db.QueryRowContext(
		ctx,
		`SELECT last_hash, projection_version FROM sync_state WHERE session_id = ?`,
		sessionID,
	).Scan(&hash, &projectionVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if projectionVersion < session.ProjectionVersion {
		return hash, false, nil
	}
	return hash, true, nil
}

// RecordSync upserts the hash + timestamp the importer just observed.
// Foreign key on session_id means the parent session row must already
// exist before this is called.
func (s *Store) RecordSync(ctx context.Context, sessionID, hash string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sync_state (session_id, last_hash, last_synced_at, projection_version)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			last_hash          = excluded.last_hash,
			last_synced_at     = excluded.last_synced_at,
			projection_version = excluded.projection_version
	`, sessionID, hash, formatTime(time.Now()), session.ProjectionVersion)
	return err
}
