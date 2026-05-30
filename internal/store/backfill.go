package store

import (
	"context"
	"database/sql"
	"fmt"
)

// DistinctProjectPathsNeedingIdentity returns every distinct cwd
// (sessions.project_path) that has at least one row missing BOTH
// project_remote AND project_marker. The CLI uses this to drive a
// one-shot resolution pass on first sync after migration 0002.
//
// Empty paths and NULLs are excluded. Order is stable for deterministic
// tests but not load-bearing.
func (s *Store) DistinctProjectPathsNeedingIdentity(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT project_path
		FROM sessions
		WHERE project_path IS NOT NULL
		  AND project_path != ''
		  AND project_remote IS NULL
		  AND project_marker IS NULL
		ORDER BY project_path
	`)
	if err != nil {
		return nil, fmt.Errorf("query distinct project paths: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// FillProjectIdentity sets project_remote and/or project_marker on every
// session row whose project_path equals path AND whose target column is
// still NULL. Either argument may be empty — empty values are skipped so
// the caller doesn't have to special-case partial matches. Returns the
// pair (remoteRowsUpdated, markerRowsUpdated).
func (s *Store) FillProjectIdentity(ctx context.Context, path, remote, marker string) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	var remoteN, markerN sql.Result
	if remote != "" {
		remoteN, err = tx.ExecContext(ctx, `
			UPDATE sessions SET project_remote = ?
			WHERE project_path = ? AND project_remote IS NULL
		`, remote, path)
		if err != nil {
			return 0, 0, fmt.Errorf("fill project_remote: %w", err)
		}
	}
	if marker != "" {
		markerN, err = tx.ExecContext(ctx, `
			UPDATE sessions SET project_marker = ?
			WHERE project_path = ? AND project_marker IS NULL
		`, marker, path)
		if err != nil {
			return 0, 0, fmt.Errorf("fill project_marker: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	var rn, mn int64
	if remoteN != nil {
		rn, _ = remoteN.RowsAffected()
	}
	if markerN != nil {
		mn, _ = markerN.RowsAffected()
	}
	return rn, mn, nil
}
