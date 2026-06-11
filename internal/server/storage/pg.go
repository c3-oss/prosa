// Package storage wraps the Postgres pool and the S3-compatible
// object store. Both Open helpers run the necessary setup (migrations
// for Postgres; bucket creation for S3) so the caller only sees
// "ready" handles.
package storage

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	migrations "github.com/c3-oss/prosa/migrations/server"
)

// OpenPG opens a pooled Postgres connection and applies pending migrations.
// The pool is returned even on migration failure so the caller can close it.
func OpenPG(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse PROSA_DB_URL: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if err := migratePG(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// migratePG mirrors internal/store/migrations.go for the Postgres store.
func migratePG(ctx context.Context, pool *pgxpool.Pool) error {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("read embedded server migrations: %w", err)
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
		version, err := parseVersion(name)
		if err != nil {
			return fmt.Errorf("parse version %s: %w", name, err)
		}
		applied, err := versionApplied(ctx, pool, version)
		if err != nil {
			return err
		}
		if applied {
			continue
		}

		body, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING`,
			version,
		); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record version %d: %w", version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
	}
	return nil
}

func parseVersion(name string) (int, error) {
	underscore := strings.Index(name, "_")
	if underscore <= 0 {
		return 0, fmt.Errorf("malformed migration name %q", name)
	}
	return strconv.Atoi(name[:underscore])
}

func versionApplied(ctx context.Context, pool *pgxpool.Pool, version int) (bool, error) {
	var exists bool
	err := pool.QueryRow(
		ctx,
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables
		                WHERE table_name = 'schema_migrations')`,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check schema_migrations exists: %w", err)
	}
	if !exists {
		return false, nil
	}
	var n int
	if err := pool.QueryRow(
		ctx,
		`SELECT COUNT(*) FROM schema_migrations WHERE version = $1`, version,
	).Scan(&n); err != nil {
		return false, fmt.Errorf("read schema_migrations: %w", err)
	}
	return n > 0, nil
}
