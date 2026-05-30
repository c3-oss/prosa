// Package store wraps the local SQLite database that holds the canonical
// session metadata projected from raw agent transcripts. The package owns
// the open/close lifecycle, applies embedded migrations, and exposes typed
// helpers for the importer and CLI layers.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite" // pure-Go driver, registers "sqlite"

	"github.com/c3-oss/prosa/migrations/local"
)

const driverName = "sqlite"

// Store is a thin handle around the underlying database. It is safe for
// concurrent use; modernc.org/sqlite serializes writes internally.
type Store struct {
	db *sql.DB
}

// ErrStoreNotInitialized is returned by OpenReadOnly when the database
// file does not exist. Callers should surface the message verbatim so
// the user knows to run `prosa sync` first.
var ErrStoreNotInitialized = errors.New("prosa store not initialized; run `prosa sync` first")

// ErrStoreNeedsMigration is returned by OpenReadOnly when the embedded
// migrations include a version higher than anything recorded in the
// on-disk schema_migrations table — read-only callers can't apply
// migrations themselves.
var ErrStoreNeedsMigration = errors.New("prosa store needs migration; run `prosa sync` or another write command first")

// Open creates the parent directory if needed, opens the SQLite file
// with WAL + foreign-keys + synchronous=NORMAL + a 5s busy_timeout, and
// applies any pending migrations before returning a ready Store. Use
// this for any code path that may write — sync, import, denoise.
func Open(ctx context.Context, path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)",
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

// OpenReadOnly opens the SQLite file in mode=ro for the read paths used
// by timeline, search, show, and analytics commands. It never creates
// directories, never runs migrations, and never enables WAL — so it can
// run safely while sync holds the writer connection. busy_timeout=5s
// makes it ride out brief writer contention; the bounded pool keeps a
// single process from saturating SQLite's internal reader serialization.
//
// Returns ErrStoreNotInitialized when path does not exist, and
// ErrStoreNeedsMigration when the embedded schema is newer than what is
// recorded on disk — both messages are user-facing.
func OpenReadOnly(ctx context.Context, path string) (*Store, error) {
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrStoreNotInitialized
		}
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}

	dsn := fmt.Sprintf(
		"file:%s?mode=ro&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)",
		path,
	)
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite (ro): %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite (ro): %w", err)
	}

	s := &Store{db: db}
	if err := s.checkSchemaCurrent(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// checkSchemaCurrent compares the highest embedded migration version to
// the highest version recorded in schema_migrations. Used only on the
// read-only open path — the writer applies migrations itself.
func (s *Store) checkSchemaCurrent(ctx context.Context) error {
	embedded, err := highestEmbeddedVersion()
	if err != nil {
		return fmt.Errorf("scan embedded migrations: %w", err)
	}

	var tableName string
	err = s.db.QueryRowContext(
		ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`,
	).Scan(&tableName)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrStoreNeedsMigration
	}
	if err != nil {
		return fmt.Errorf("probe schema_migrations: %w", err)
	}

	var onDisk sql.NullInt64
	if err := s.db.QueryRowContext(
		ctx,
		`SELECT MAX(version) FROM schema_migrations`,
	).Scan(&onDisk); err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	if !onDisk.Valid || int(onDisk.Int64) < embedded {
		return ErrStoreNeedsMigration
	}
	return nil
}

// highestEmbeddedVersion walks the embedded migrations FS and returns
// the largest numeric prefix among the *.up.sql files. Returns 0 when
// no migration files are present, which is treated as "no schema is
// current" by callers.
func highestEmbeddedVersion() (int, error) {
	entries, err := fs.ReadDir(local.FS, ".")
	if err != nil {
		return 0, err
	}
	versions := make([]int, 0, len(entries))
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".up.sql") {
			continue
		}
		v, err := parseMigrationVersion(n)
		if err != nil {
			continue
		}
		versions = append(versions, v)
	}
	if len(versions) == 0 {
		return 0, nil
	}
	sort.Ints(versions)
	return versions[len(versions)-1], nil
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
