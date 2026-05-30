// Package store wraps the local SQLite database that holds the canonical
// session metadata projected from raw agent transcripts. The package owns
// the open/close lifecycle, applies embedded migrations, and exposes typed
// helpers for the importer and CLI layers.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go driver, registers "sqlite"
)

const driverName = "sqlite"

// Store is a thin handle around the underlying database. It is safe for
// concurrent use; modernc.org/sqlite serializes writes internally.
type Store struct {
	db *sql.DB
}

// Open creates the parent directory if needed, opens the SQLite file with
// WAL + foreign-keys + synchronous=NORMAL, and applies any pending
// migrations before returning a ready Store.
func Open(ctx context.Context, path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)",
		path,
	)
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error {
	return s.db.Close()
}

// DB exposes the raw *sql.DB for ad-hoc queries (e.g. tests and CLI
// verification commands). Avoid using it from package internals — prefer
// adding a typed method.
func (s *Store) DB() *sql.DB {
	return s.db
}
