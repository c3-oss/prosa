package store

import (
	"context"
	"fmt"

	"github.com/c3-oss/prosa/pkg/session"
)

// InsertTurns replaces the turn set for a session in one transaction.
// Old rows are deleted first to keep re-imports idempotent. The FTS5
// virtual table is kept in sync by the AFTER INSERT / AFTER DELETE
// triggers defined in the migration.
func (s *Store) InsertTurns(ctx context.Context, sessionID string, turns []session.Turn) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `DELETE FROM turns WHERE session_id = ?`, sessionID); err != nil {
		return fmt.Errorf("delete prior turns for %s: %w", sessionID, err)
	}

	if len(turns) == 0 {
		return tx.Commit()
	}

	stmt, err := tx.PrepareContext(ctx, `INSERT INTO turns(session_id, role, content, ts) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare turn insert: %w", err)
	}
	defer stmt.Close()

	for i, t := range turns {
		if _, err := stmt.ExecContext(ctx, sessionID, t.Role, t.Content, formatTime(t.Timestamp)); err != nil {
			return fmt.Errorf("insert turn %d for %s: %w", i, sessionID, err)
		}
	}

	return tx.Commit()
}
