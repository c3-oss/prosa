package store

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"github.com/c3-oss/prosa/migrations/local"
)

// migrate applies all *.up.sql files under migrations/local/, in lexical
// order, recording applied versions in schema_migrations. Each file runs
// in its own transaction; failure rolls the file back but leaves earlier
// migrations applied.
func (s *Store) migrate(ctx context.Context) error {
	entries, err := fs.ReadDir(local.FS, ".")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}

	var ups []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".up.sql") {
			ups = append(ups, name)
		}
	}
	sort.Strings(ups)

	for _, name := range ups {
		version, err := parseMigrationVersion(name)
		if err != nil {
			return fmt.Errorf("parse version %s: %w", name, err)
		}
		applied, err := s.versionApplied(ctx, version)
		if err != nil {
			return err
		}
		if applied {
			continue
		}

		body, err := fs.ReadFile(local.FS, name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.ExecContext(
			ctx,
			`INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)`,
			version,
		); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record version %d: %w", version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
	}
	return nil
}

// parseMigrationVersion turns "0001_init.up.sql" into 1.
func parseMigrationVersion(name string) (int, error) {
	underscore := strings.Index(name, "_")
	if underscore <= 0 {
		return 0, fmt.Errorf("malformed migration name %q", name)
	}
	v, err := strconv.Atoi(name[:underscore])
	if err != nil {
		return 0, fmt.Errorf("non-numeric prefix in %q: %w", name, err)
	}
	return v, nil
}

// versionApplied returns true when schema_migrations contains the given
// version. The schema_migrations table is created by 0001 itself, so on a
// fresh database the query errors with "no such table"; we swallow that
// case and treat the version as not yet applied.
func (s *Store) versionApplied(ctx context.Context, version int) (bool, error) {
	var n int
	err := s.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`,
		version,
	).Scan(&n)
	if err != nil {
		// First run: schema_migrations doesn't exist yet. Apply.
		return false, nil
	}
	return n > 0, nil
}
