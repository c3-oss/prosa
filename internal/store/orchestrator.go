package store

import (
	"context"
	"fmt"

	"github.com/c3-oss/prosa/internal/sessionkind"
)

// RefreshOrchestratorKinds reconciles the edge-dependent "orchestrator"
// kind across the whole store. A session is an orchestrator when at least
// one other session names it as parent_session_id. This cannot be decided
// while projecting a single session (the parent may be imported before or
// after its children), so the import sweep calls this once after all
// importers complete. Idempotent: it adds the kind to every current parent
// and removes it from sessions that no longer have children.
func (s *Store) RefreshOrchestratorKinds(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO session_kinds(session_id, kind)
		SELECT DISTINCT parent_session_id, ?
		FROM sessions
		WHERE parent_session_id IS NOT NULL AND parent_session_id != ''
		  AND parent_session_id IN (SELECT id FROM sessions)
	`, sessionkind.KindOrchestrator); err != nil {
		return fmt.Errorf("add orchestrator kinds: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		DELETE FROM session_kinds
		WHERE kind = ?
		  AND session_id NOT IN (
		    SELECT DISTINCT parent_session_id FROM sessions
		    WHERE parent_session_id IS NOT NULL AND parent_session_id != ''
		  )
	`, sessionkind.KindOrchestrator); err != nil {
		return fmt.Errorf("prune orchestrator kinds: %w", err)
	}

	return tx.Commit()
}
