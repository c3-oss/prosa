package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	migrations "github.com/c3-oss/prosa/migrations/server"
)

func TestServerMigrationUpDownUpIdentity(t *testing.T) {
	dbURL := os.Getenv("PROSA_TEST_PG_URL")
	if dbURL == "" {
		t.Skip("set PROSA_TEST_PG_URL to run Postgres migration integration tests")
	}

	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err)
	t.Cleanup(adminPool.Close)

	schema := "migration_test_" + randomSchemaHex(t, 8)
	_, err = adminPool.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
	})

	cfg, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	pairs := serverMigrationPairs(t)
	for _, pair := range pairs {
		t.Run(pair.up, func(t *testing.T) {
			applyServerMigration(t, ctx, pool, pair.up)
			recordServerMigration(t, ctx, pool, pair.version)
			before := serverSchemaSnapshot(t, ctx, pool, schema)

			removeServerMigration(t, ctx, pool, pair.version)
			applyServerMigration(t, ctx, pool, pair.down)

			applyServerMigration(t, ctx, pool, pair.up)
			recordServerMigration(t, ctx, pool, pair.version)
			after := serverSchemaSnapshot(t, ctx, pool, schema)

			require.Equalf(t, before, after, "%s", formatSchemaDiff(before, after))
		})
	}
}

func TestServerUsageSortIndexMigration(t *testing.T) {
	up, err := fs.ReadFile(migrations.FS, "0010_session_usage_total_tokens_index.up.sql")
	require.NoError(t, err)
	require.Contains(t, string(up), "CREATE INDEX session_usage_total_tokens_idx")
	require.Contains(t, string(up), "session_usage(total_tokens DESC, session_id)")

	down, err := fs.ReadFile(migrations.FS, "0010_session_usage_total_tokens_index.down.sql")
	require.NoError(t, err)
	require.Contains(t, string(down), "DROP INDEX IF EXISTS session_usage_total_tokens_idx")
}

type pgMigrationPair struct {
	version int
	up      string
	down    string
}

func serverMigrationPairs(t *testing.T) []pgMigrationPair {
	t.Helper()
	entries, err := fs.ReadDir(migrations.FS, ".")
	require.NoError(t, err)

	ups := map[int]string{}
	downs := map[int]string{}
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case strings.HasSuffix(name, ".up.sql"):
			version, err := parseVersion(name)
			require.NoError(t, err)
			ups[version] = name
		case strings.HasSuffix(name, ".down.sql"):
			version, err := parseVersion(name)
			require.NoError(t, err)
			downs[version] = name
		}
	}

	var versions []int
	for version := range ups {
		versions = append(versions, version)
	}
	sort.Ints(versions)

	var pairs []pgMigrationPair
	for _, version := range versions {
		require.NotEmpty(t, downs[version], "missing down migration for %s", ups[version])
		pairs = append(pairs, pgMigrationPair{
			version: version,
			up:      ups[version],
			down:    downs[version],
		})
	}
	return pairs
}

func applyServerMigration(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) {
	t.Helper()
	body, err := fs.ReadFile(migrations.FS, name)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(body))
	require.NoErrorf(t, err, "apply %s", name)
}

func recordServerMigration(t *testing.T, ctx context.Context, pool *pgxpool.Pool, version int) {
	t.Helper()
	if !serverTableExists(t, ctx, pool, "schema_migrations") {
		return
	}
	_, err := pool.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING`, version)
	require.NoError(t, err)
}

func removeServerMigration(t *testing.T, ctx context.Context, pool *pgxpool.Pool, version int) {
	t.Helper()
	if !serverTableExists(t, ctx, pool, "schema_migrations") {
		return
	}
	_, err := pool.Exec(ctx, `DELETE FROM schema_migrations WHERE version = $1`, version)
	require.NoError(t, err)
}

func serverTableExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var exists bool
	err := pool.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = $1
		)`,
		name,
	).Scan(&exists)
	require.NoError(t, err)
	return exists
}

func serverSchemaSnapshot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, schema string) []string {
	t.Helper()
	var out []string

	out = append(out, querySnapshotRows(t, ctx, pool, `
		SELECT 'column|' || c.relname || '|' || a.attname || '|' ||
		       pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' ||
		       a.attnotnull::text || '|' || a.attgenerated::text || '|' ||
		       COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '')
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
		WHERE n.nspname = $1
		  AND c.relkind IN ('r', 'p')
		  AND a.attnum > 0
		  AND NOT a.attisdropped
		ORDER BY c.relname, a.attname
	`, schema)...)

	out = append(out, querySnapshotRows(t, ctx, pool, `
		SELECT 'relation|' || c.relkind::text || '|' || c.relname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1
		  AND c.relkind IN ('r', 'p')
		ORDER BY c.relkind, c.relname
	`, schema)...)

	out = append(out, querySnapshotRows(t, ctx, pool, `
		SELECT 'index|' || indexname || '|' || indexdef
		FROM pg_indexes
		WHERE schemaname = $1
		ORDER BY indexname
	`, schema)...)

	out = append(out, querySnapshotRows(t, ctx, pool, `
		SELECT 'constraint|' || con.conname || '|' || con.contype::text || '|' || con.conrelid::regclass::text || '|' ||
		       pg_get_constraintdef(con.oid)
		FROM pg_constraint con
		JOIN pg_namespace n ON n.oid = con.connamespace
		WHERE n.nspname = $1
		ORDER BY con.conname, con.conrelid::regclass::text
	`, schema)...)

	out = append(out, querySnapshotRows(t, ctx, pool, `
		SELECT 'trigger|' || tg.tgname || '|' || tg.tgrelid::regclass::text || '|' || pg_get_triggerdef(tg.oid)
		FROM pg_trigger tg
		JOIN pg_class c ON c.oid = tg.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1
		  AND NOT tg.tgisinternal
		ORDER BY tg.tgname, tg.tgrelid::regclass::text
	`, schema)...)

	out = append(out, querySnapshotRows(t, ctx, pool, `
		SELECT 'function|' || p.proname || '|' || pg_get_functiondef(p.oid)
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = $1
		ORDER BY p.proname
	`, schema)...)

	sort.Strings(out)
	return out
}

func querySnapshotRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query, schema string) []string {
	t.Helper()
	rows, err := pool.Query(ctx, query, schema)
	require.NoError(t, err)
	defer rows.Close()

	var out []string
	for rows.Next() {
		var row string
		require.NoError(t, rows.Scan(&row))
		out = append(out, row)
	}
	require.NoError(t, rows.Err())
	return out
}

func randomSchemaHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return hex.EncodeToString(b)
}

func formatSchemaDiff(before, after []string) string {
	return fmt.Sprintf("before:\n%s\n\nafter:\n%s", strings.Join(before, "\n"), strings.Join(after, "\n"))
}
