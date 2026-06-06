package store

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/migrations/local"
)

func TestLocalMigrationUpDownUpIdentity(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := sql.Open(driverName, "file::memory:?_pragma=foreign_keys(ON)")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	pairs := localMigrationPairs(t)
	for _, pair := range pairs {
		t.Run(pair.up, func(t *testing.T) {
			applyLocalMigration(t, ctx, db, pair.up)
			recordLocalMigration(t, ctx, db, pair.version)
			before := localSchemaSnapshot(t, ctx, db)

			removeLocalMigration(t, ctx, db, pair.version)
			applyLocalMigration(t, ctx, db, pair.down)

			applyLocalMigration(t, ctx, db, pair.up)
			recordLocalMigration(t, ctx, db, pair.version)
			after := localSchemaSnapshot(t, ctx, db)

			require.Equal(t, before, after)
		})
	}
}

type migrationPair struct {
	version int
	up      string
	down    string
}

func localMigrationPairs(t *testing.T) []migrationPair {
	t.Helper()
	entries, err := fs.ReadDir(local.FS, ".")
	require.NoError(t, err)

	ups := map[int]string{}
	downs := map[int]string{}
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case strings.HasSuffix(name, ".up.sql"):
			version, err := parseMigrationVersion(name)
			require.NoError(t, err)
			ups[version] = name
		case strings.HasSuffix(name, ".down.sql"):
			version, err := parseMigrationVersion(name)
			require.NoError(t, err)
			downs[version] = name
		}
	}

	var versions []int
	for version := range ups {
		versions = append(versions, version)
	}
	sort.Ints(versions)

	var pairs []migrationPair
	for _, version := range versions {
		require.NotEmpty(t, downs[version], "missing down migration for %s", ups[version])
		pairs = append(pairs, migrationPair{
			version: version,
			up:      ups[version],
			down:    downs[version],
		})
	}
	return pairs
}

func applyLocalMigration(t *testing.T, ctx context.Context, db *sql.DB, name string) {
	t.Helper()
	body, err := fs.ReadFile(local.FS, name)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, string(body))
	require.NoErrorf(t, err, "apply %s", name)
}

func recordLocalMigration(t *testing.T, ctx context.Context, db *sql.DB, version int) {
	t.Helper()
	if !localTableExists(t, ctx, db, "schema_migrations") {
		return
	}
	_, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)`, version)
	require.NoError(t, err)
}

func removeLocalMigration(t *testing.T, ctx context.Context, db *sql.DB, version int) {
	t.Helper()
	if !localTableExists(t, ctx, db, "schema_migrations") {
		return
	}
	_, err := db.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version = ?`, version)
	require.NoError(t, err)
}

func localTableExists(t *testing.T, ctx context.Context, db *sql.DB, name string) bool {
	t.Helper()
	var count int
	err := db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?`,
		name,
	).Scan(&count)
	require.NoError(t, err)
	return count > 0
}

func localSchemaSnapshot(t *testing.T, ctx context.Context, db *sql.DB) []string {
	t.Helper()
	rows, err := db.QueryContext(ctx, `
		SELECT type, name, tbl_name, COALESCE(sql, '')
		FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%'
		ORDER BY type, name, tbl_name
	`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	var out []string
	for rows.Next() {
		var typ, name, table, sql string
		require.NoError(t, rows.Scan(&typ, &name, &table, &sql))
		out = append(out, fmt.Sprintf("%s|%s|%s|%s", typ, name, table, sql))
	}
	require.NoError(t, rows.Err())
	return out
}
