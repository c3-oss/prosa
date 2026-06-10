package store

import (
	"context"

	"github.com/c3-oss/prosa/pkg/session"
)

// WriteSession persists a complete projection — session row + session_usage
// + session_tools, turns, and the sync_state hash — in a single
// transaction. Importers call this instead of UpsertSession + InsertTurns +
// RecordSync so a crash mid-write can never leave a session row visible
// without its turns or with a stale sync_state.
func (s *Store) WriteSession(
	ctx context.Context,
	sess session.Session,
	tools []session.ToolUsage,
	turns []session.Turn,
	hash string,
) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := upsertSessionTx(ctx, tx, sess, tools); err != nil {
		return err
	}
	if err := insertTurnsTx(ctx, tx, sess.ID, turns); err != nil {
		return err
	}
	if err := recordSyncTx(ctx, tx, sess.ID, hash); err != nil {
		return err
	}
	return tx.Commit()
}
